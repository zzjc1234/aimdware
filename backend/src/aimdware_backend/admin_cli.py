"""TT-side admin CLI for the aimdware backend.

Operates directly on the configured database. Run as:

    AIMDWARE_DATABASE_URL=sqlite:///./aimdware.db \\
        uv run aimdware-admin token issue --user alice

Subcommands:
    user create  / user list
    course create / course list
    enroll
    token issue / token revoke / token list
    record list  / record payload
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import inspect
import json
import secrets
import sys
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlmodel import Session, select

from aimdware_backend.db import get_engine
from aimdware_backend.models import (
    BlobStatus,
    ContextRecord,
    Course,
    Enrollment,
    Role,
    StudentToken,
    User,
    utcnow,
)
from aimdware_backend.roster import RosterRow, read_roster

# --- importable command functions (also covered by tests) ---------------


DEFAULT_EMAIL_DOMAIN = "sjtu.edu.cn"


def derive_email(jaccount: str, domain: str = DEFAULT_EMAIL_DOMAIN) -> str:
    """SJTU jaccount is the email local-part, so derive it deterministically."""
    return f"{jaccount}@{domain}"


def user_create(
    session: Session,
    *,
    jaccount: str,
    email: str,
    display_name: str,
    student_id: str | None = None,
) -> User:
    """Create a new User row and return it."""
    user = User(
        jaccount=jaccount,
        email=email,
        display_name=display_name,
        student_id=student_id,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def user_get(session: Session, jaccount: str) -> User:
    """Return the User with this jaccount, or raise LookupError."""
    user = session.exec(select(User).where(User.jaccount == jaccount)).first()
    if user is None:
        raise LookupError(f"no user with jaccount={jaccount!r}")
    return user


def course_create(session: Session, *, code: str, title: str, semester: str) -> Course:
    """Create a new Course row and return it."""
    course = Course(code=code, title=title, semester=semester)
    session.add(course)
    session.commit()
    session.refresh(course)
    return course


def course_get(session: Session, code: str) -> Course:
    """Return the Course with this code, or raise LookupError."""
    course = session.exec(select(Course).where(Course.code == code)).first()
    if course is None:
        raise LookupError(f"no course with code={code!r}")
    return course


def enroll(
    session: Session,
    *,
    jaccount: str,
    course_code: str,
    role: Role = Role.student,
) -> Enrollment:
    """Enroll a user in a course (idempotent — existing row returned as-is)."""
    user = user_get(session, jaccount)
    course = course_get(session, course_code)
    existing = session.get(Enrollment, (user.id, course.id))
    if existing is not None:
        return existing
    e = Enrollment(user_id=user.id, course_id=course.id, role=role)
    session.add(e)
    session.commit()
    session.refresh(e)
    return e


def token_issue(
    session: Session, *, jaccount: str, plaintext: str | None = None
) -> tuple[StudentToken, str]:
    """Issue a fresh token for the user, revoking any active prior token.

    Returns the StudentToken row plus the *plaintext* — this is the only
    time the plaintext is observable; the DB only ever sees sha256(plaintext).
    """
    user = user_get(session, jaccount)
    active = session.exec(
        select(StudentToken)
        .where(StudentToken.user_id == user.id)
        .where(StudentToken.revoked_at.is_(None))  # type: ignore[union-attr]
    ).first()
    if active is not None:
        active.revoked_at = utcnow()
        session.add(active)
        session.commit()

    if plaintext is None:
        plaintext = "st_" + secrets.token_urlsafe(32)
    digest = hashlib.sha256(plaintext.encode()).digest()
    tok = StudentToken(user_id=user.id, token_hash=digest, prefix=plaintext[:8])
    session.add(tok)
    session.commit()
    session.refresh(tok)
    return tok, plaintext


def token_revoke(session: Session, *, prefix: str) -> int:
    """Revoke all active tokens whose stored prefix matches. Returns count."""
    rows = session.exec(
        select(StudentToken)
        .where(StudentToken.prefix == prefix)
        .where(StudentToken.revoked_at.is_(None))  # type: ignore[union-attr]
    ).all()
    for r in rows:
        r.revoked_at = utcnow()
        session.add(r)
    session.commit()
    return len(rows)


def revoke_tokens_for_user(session: Session, jaccount: str) -> int:
    """Revoke ALL active tokens for a user (by jaccount). Returns count."""
    user = user_get(session, jaccount)
    rows = session.exec(
        select(StudentToken)
        .where(StudentToken.user_id == user.id)
        .where(StudentToken.revoked_at.is_(None))  # type: ignore[union-attr]
    ).all()
    for r in rows:
        r.revoked_at = utcnow()
        session.add(r)
    session.commit()
    return len(rows)


# --- batch (CSV) operations ---------------------------------------------
#
# Each runs one roster row at a time, continues past per-row failures, and
# returns a list of result dicts: {"jaccount", "status", ...}. Status values:
# created/exists/enrolled/issued/revoked/error. The caller decides the exit
# code from whether any row is "error".


def batch_user_create(
    session: Session,
    rows: list[RosterRow],
    *,
    email_domain: str = DEFAULT_EMAIL_DOMAIN,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            if session.exec(select(User).where(User.jaccount == row.jaccount)).first():
                out.append({"jaccount": row.jaccount, "status": "exists"})
                continue
            u = user_create(
                session,
                jaccount=row.jaccount,
                email=derive_email(row.jaccount, email_domain),
                display_name=row.name,
                student_id=row.student_id,
            )
            out.append({"jaccount": row.jaccount, "status": "created", "email": u.email})
        except Exception as e:  # noqa: BLE001 - per-row isolation; report and continue
            session.rollback()
            out.append({"jaccount": row.jaccount, "status": "error", "error": str(e)})
    return out


def batch_enroll(
    session: Session,
    rows: list[RosterRow],
    *,
    course_code: str,
    role: Role = Role.student,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            user = user_get(session, row.jaccount)
            course = course_get(session, course_code)
            if session.get(Enrollment, (user.id, course.id)) is not None:
                out.append({"jaccount": row.jaccount, "status": "exists"})
                continue
            enroll(session, jaccount=row.jaccount, course_code=course_code, role=role)
            out.append({"jaccount": row.jaccount, "status": "enrolled"})
        except Exception as e:  # noqa: BLE001 - per-row isolation; report and continue
            session.rollback()
            out.append({"jaccount": row.jaccount, "status": "error", "error": str(e)})
    return out


def batch_token_issue(session: Session, rows: list[RosterRow]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            tok, plaintext = token_issue(session, jaccount=row.jaccount)
            out.append(
                {
                    "jaccount": row.jaccount,
                    "status": "issued",
                    "plaintext": plaintext,
                    "prefix": tok.prefix,
                }
            )
        except Exception as e:  # noqa: BLE001 - per-row isolation; report and continue
            session.rollback()
            out.append({"jaccount": row.jaccount, "status": "error", "error": str(e)})
    return out


def batch_token_revoke(session: Session, rows: list[RosterRow]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            n = revoke_tokens_for_user(session, row.jaccount)
            out.append({"jaccount": row.jaccount, "status": "revoked", "revoked": n})
        except Exception as e:  # noqa: BLE001 - per-row isolation; report and continue
            session.rollback()
            out.append({"jaccount": row.jaccount, "status": "error", "error": str(e)})
    return out


# --- output helpers -----------------------------------------------------


def _print_json(obj: Any) -> None:
    print(json.dumps(obj, default=str, indent=2))


def _emit_batch(results: list[dict[str, Any]]) -> int:
    """Print batch results and return a non-zero code if any row errored."""
    _print_json(results)
    return 1 if any(r.get("status") == "error" for r in results) else 0


# --- CLI command dispatchers --------------------------------------------


def _cmd_user_create(session: Session, args: argparse.Namespace) -> int:
    if args.csv:
        return _emit_batch(
            batch_user_create(session, read_roster(args.csv), email_domain=args.email_domain)
        )
    if not (args.jaccount and args.name):
        print("error: provide --csv, or both --jaccount and --name", file=sys.stderr)
        return 2
    email = args.email or derive_email(args.jaccount, args.email_domain)
    u = user_create(
        session,
        jaccount=args.jaccount,
        email=email,
        display_name=args.name,
        student_id=args.student_id,
    )
    _print_json(
        {
            "id": str(u.id),
            "jaccount": u.jaccount,
            "email": u.email,
            "student_id": u.student_id,
        }
    )
    return 0


def _cmd_user_list(session: Session, _args: argparse.Namespace) -> None:
    rows = session.exec(select(User).order_by(User.created_at)).all()
    _print_json(
        [
            {
                "id": str(u.id),
                "jaccount": u.jaccount,
                "email": u.email,
                "active": u.is_active,
            }
            for u in rows
        ]
    )


def _cmd_course_create(session: Session, args: argparse.Namespace) -> None:
    c = course_create(session, code=args.code, title=args.title, semester=args.semester)
    _print_json({"id": str(c.id), "code": c.code, "title": c.title, "semester": c.semester})


def _cmd_course_list(session: Session, _args: argparse.Namespace) -> None:
    rows = session.exec(select(Course).order_by(Course.created_at)).all()
    _print_json(
        [
            {
                "id": str(c.id),
                "code": c.code,
                "title": c.title,
                "semester": c.semester,
            }
            for c in rows
        ]
    )


def _cmd_enroll(session: Session, args: argparse.Namespace) -> int:
    role = Role(args.role)
    if args.csv:
        return _emit_batch(
            batch_enroll(session, read_roster(args.csv), course_code=args.course, role=role)
        )
    if not args.user:
        print("error: provide --csv, or --user", file=sys.stderr)
        return 2
    e = enroll(session, jaccount=args.user, course_code=args.course, role=role)
    _print_json(
        {
            "user_id": str(e.user_id),
            "course_id": str(e.course_id),
            "role": e.role,
        }
    )
    return 0


def _cmd_token_issue(session: Session, args: argparse.Namespace) -> int:
    if args.csv:
        return _emit_batch(batch_token_issue(session, read_roster(args.csv)))
    if not args.user:
        print("error: provide --csv, or --user", file=sys.stderr)
        return 2
    tok, plaintext = token_issue(session, jaccount=args.user)
    # Plaintext shown EXACTLY ONCE — student must save it now.
    _print_json({"plaintext": plaintext, "prefix": tok.prefix, "id": str(tok.id)})
    return 0


def _cmd_token_revoke(session: Session, args: argparse.Namespace) -> int:
    if args.csv:
        return _emit_batch(batch_token_revoke(session, read_roster(args.csv)))
    if not args.prefix:
        print("error: provide --csv, or --prefix", file=sys.stderr)
        return 2
    n = token_revoke(session, prefix=args.prefix)
    _print_json({"revoked": n})
    return 0


def _cmd_token_list(session: Session, args: argparse.Namespace) -> None:
    q = select(StudentToken)
    if args.user:
        user = user_get(session, args.user)
        q = q.where(StudentToken.user_id == user.id)
    rows = session.exec(q.order_by(StudentToken.created_at.desc())).all()
    _print_json(
        [
            {
                "id": str(t.id),
                "user_id": str(t.user_id),
                "prefix": t.prefix,
                "created_at": t.created_at.isoformat(),
                "revoked_at": (t.revoked_at.isoformat() if t.revoked_at else None),
            }
            for t in rows
        ]
    )


def _cmd_record_list(session: Session, args: argparse.Namespace) -> None:
    # Reminder: blob_status=uploaded does NOT mean "this record's hash is
    # currently verifiable on jbox" for non-latest turns of a session.
    # See BlobStatus docstring in models.py.
    q = select(ContextRecord).order_by(ContextRecord.ts.desc()).limit(args.limit)
    if args.course:
        c = course_get(session, args.course)
        q = q.where(ContextRecord.course_id == c.id)
    if args.user:
        u = user_get(session, args.user)
        q = q.where(ContextRecord.user_id == u.id)
    if args.assignment:
        q = q.where(ContextRecord.assignment == args.assignment)
    if args.status:
        q = q.where(ContextRecord.blob_status == BlobStatus(args.status))
    rows = session.exec(q).all()
    _print_json(
        [
            {
                "id": str(r.id),
                "ts": r.ts.isoformat(),
                "user_id": str(r.user_id),
                "course_id": str(r.course_id),
                "assignment": r.assignment,
                "model": r.model,
                "blob_size": r.blob_size,
                "blob_status": r.blob_status,
                "blob_uri": r.blob_uri,
            }
            for r in rows
        ]
    )


async def _cmd_record_payload(session: Session, args: argparse.Namespace) -> None:
    """Fetch the blob from Tbox and verify its hash."""
    from aimdware_backend.jbox import JboxNotFound, default_reader

    rid = UUID(args.id)
    record = session.get(ContextRecord, rid)
    if record is None:
        print(f"no record with id={args.id}", file=sys.stderr)
        sys.exit(1)
    reader = default_reader()
    try:
        bytes_ = await reader.get(record.blob_uri)
    except JboxNotFound:
        print(f"blob missing from jbox at {record.blob_uri}", file=sys.stderr)
        sys.exit(2)
    actual = hashlib.sha256(bytes_).digest()
    verified = actual == record.blob_hash
    _print_json(
        {
            "record_id": args.id,
            "blob_uri": record.blob_uri,
            "blob_size_stored": record.blob_size,
            "blob_size_actual": len(bytes_),
            "blob_hash_stored": record.blob_hash.hex(),
            "blob_hash_actual": actual.hex(),
            "verified": verified,
            "payload_utf8": bytes_.decode("utf-8", errors="replace"),
        }
    )


# --- argparse plumbing ---------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="aimdware-admin", description="TT admin CLI for aimdware backend"
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    # user
    p_user = sub.add_parser("user", help="manage users")
    s_user = p_user.add_subparsers(dest="op", required=True)
    p_uc = s_user.add_parser("create")
    p_uc.add_argument("--jaccount", help="single-user mode")
    p_uc.add_argument("--email", help="derived as <jaccount>@<domain> if omitted")
    p_uc.add_argument("--name")
    p_uc.add_argument("--student-id", dest="student_id", default=None)
    p_uc.add_argument("--csv", help="roster CSV: name,student_id,jaccount")
    p_uc.add_argument("--email-domain", dest="email_domain", default=DEFAULT_EMAIL_DOMAIN)
    p_uc.set_defaults(func=_cmd_user_create)
    s_user.add_parser("list").set_defaults(func=_cmd_user_list)

    # course
    p_course = sub.add_parser("course", help="manage courses")
    s_course = p_course.add_subparsers(dest="op", required=True)
    p_cc = s_course.add_parser("create")
    p_cc.add_argument("--code", required=True)
    p_cc.add_argument("--title", required=True)
    p_cc.add_argument("--semester", required=True)
    p_cc.set_defaults(func=_cmd_course_create)
    s_course.add_parser("list").set_defaults(func=_cmd_course_list)

    # enroll
    p_enr = sub.add_parser("enroll", help="enroll a user in a course")
    p_enr.add_argument("--user", help="user jaccount (single mode)")
    p_enr.add_argument("--course", required=True, help="course code")
    p_enr.add_argument("--role", default="student", choices=["student", "admin"])
    p_enr.add_argument("--csv", help="roster CSV: name,student_id,jaccount")
    p_enr.set_defaults(func=_cmd_enroll)

    # token
    p_tok = sub.add_parser("token", help="manage student tokens")
    s_tok = p_tok.add_subparsers(dest="op", required=True)
    p_ti = s_tok.add_parser("issue")
    p_ti.add_argument("--user", help="user jaccount (single mode)")
    p_ti.add_argument("--csv", help="roster CSV: issue for each jaccount")
    p_ti.set_defaults(func=_cmd_token_issue)
    p_tr = s_tok.add_parser("revoke")
    p_tr.add_argument("--prefix", help="8-char prefix shown when issued (single mode)")
    p_tr.add_argument("--csv", help="roster CSV: revoke all active tokens per jaccount")
    p_tr.set_defaults(func=_cmd_token_revoke)
    p_tl = s_tok.add_parser("list")
    p_tl.add_argument("--user", default=None)
    p_tl.set_defaults(func=_cmd_token_list)

    # record
    p_rec = sub.add_parser("record", help="inspect captured context records")
    s_rec = p_rec.add_subparsers(dest="op", required=True)
    p_rl = s_rec.add_parser("list")
    p_rl.add_argument("--course", default=None)
    p_rl.add_argument("--user", default=None)
    p_rl.add_argument("--assignment", default=None)
    p_rl.add_argument(
        "--status",
        default=None,
        choices=[s.value for s in BlobStatus],
    )
    p_rl.add_argument("--limit", type=int, default=50)
    p_rl.set_defaults(func=_cmd_record_list)
    p_rp = s_rec.add_parser("payload")
    p_rp.add_argument("--id", required=True, help="ContextRecord UUID")
    p_rp.set_defaults(func=_cmd_record_payload)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    engine = get_engine()
    # Do NOT call SQLModel.metadata.create_all() — production schema is
    # owned by Alembic, and create_all() can't express the partial unique
    # index that enforces "one active token per user". If we silently
    # create tables here, a later `alembic upgrade head` would fail with
    # "table already exists". Refuse early with a clear message instead.
    if not _schema_exists(engine):
        print(
            "error: database schema is missing or incomplete.\n"
            "       run  `uv run alembic upgrade head`  first.",
            file=sys.stderr,
        )
        return 2

    with Session(engine) as session:
        if inspect.iscoroutinefunction(args.func):
            rc = asyncio.run(args.func(session, args))
        else:
            rc = args.func(session, args)
    return rc if isinstance(rc, int) else 0


CURRENT_SCHEMA_REVISION = "c0a1d2e3f4b5"


def _schema_exists(engine) -> bool:  # type: ignore[no-untyped-def]
    """Probe for an Alembic-owned schema at the revision this CLI expects."""
    from sqlalchemy import inspect as sa_inspect

    try:
        insp = sa_inspect(engine)
        if not (
            insp.has_table("context_records")
            and insp.has_table("users")
            and insp.has_table("alembic_version")
        ):
            return False
        with engine.connect() as conn:
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        return version == CURRENT_SCHEMA_REVISION
    except Exception:
        return False


if __name__ == "__main__":
    sys.exit(main())
