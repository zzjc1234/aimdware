"""Tests for the TT admin CLI's importable command functions."""

from __future__ import annotations

import hashlib

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from aimdware_backend import settings
from aimdware_backend.admin_cli import (
    _schema_exists,
    batch_enroll,
    batch_token_issue,
    batch_token_revoke,
    batch_user_create,
    course_create,
    derive_email,
    enroll,
    revoke_tokens_for_user,
    token_issue,
    token_revoke,
    user_create,
    user_get,
)
from aimdware_backend.models import Course, Enrollment, Role, StudentToken, User
from aimdware_backend.roster import RosterRow


def test_user_create_adds_row(session: Session) -> None:
    u = user_create(session, jaccount="alice", email="alice@sjtu.edu.cn", display_name="Alice")
    fetched = session.exec(select(User).where(User.jaccount == "alice")).first()
    assert fetched is not None
    assert fetched.id == u.id
    assert fetched.email == "alice@sjtu.edu.cn"
    assert fetched.is_active is True


def test_user_get_raises_when_missing(session: Session) -> None:
    import pytest

    with pytest.raises(LookupError):
        user_get(session, "nobody")


def test_course_create_adds_row(session: Session) -> None:
    c = course_create(session, code="VE477", title="Algorithms", semester="2026-fall")
    fetched = session.exec(select(Course).where(Course.code == "VE477")).first()
    assert fetched is not None
    assert fetched.id == c.id


def test_enroll_links_user_and_course(session: Session) -> None:
    user_create(session, jaccount="bob", email="bob@sjtu.edu.cn", display_name="Bob")
    course_create(session, code="ECE4721J", title="Systems", semester="2026-spring")
    e = enroll(session, jaccount="bob", course_code="ECE4721J", role=Role.student)
    assert e.role == Role.student
    rows = session.exec(select(Enrollment)).all()
    assert len(rows) == 1


def test_enroll_is_idempotent(session: Session) -> None:
    user_create(session, jaccount="carol", email="carol@sjtu.edu.cn", display_name="Carol")
    course_create(session, code="ECE4721J", title="Systems", semester="2026-spring")
    enroll(session, jaccount="carol", course_code="ECE4721J")
    enroll(session, jaccount="carol", course_code="ECE4721J")
    assert len(session.exec(select(Enrollment)).all()) == 1


def test_token_issue_stores_sha256_hash_and_returns_plaintext(
    session: Session,
) -> None:
    user_create(session, jaccount="dave", email="dave@sjtu.edu.cn", display_name="Dave")
    tok, plaintext = token_issue(session, jaccount="dave")
    assert tok.token_hash == hashlib.sha256(plaintext.encode()).digest()
    assert tok.prefix == plaintext[:8]
    assert tok.revoked_at is None


def test_token_issue_revokes_prior_active_token(session: Session) -> None:
    user_create(session, jaccount="eve", email="eve@sjtu.edu.cn", display_name="Eve")
    old, _ = token_issue(session, jaccount="eve")
    new, _ = token_issue(session, jaccount="eve")
    session.refresh(old)
    assert old.revoked_at is not None
    assert new.revoked_at is None
    # Only one active token at a time.
    active = session.exec(
        select(StudentToken).where(StudentToken.revoked_at.is_(None))  # type: ignore[union-attr]
    ).all()
    assert len(active) == 1


def test_token_revoke_by_prefix(session: Session) -> None:
    user_create(session, jaccount="frank", email="frank@sjtu.edu.cn", display_name="Frank")
    tok, _ = token_issue(session, jaccount="frank")
    n = token_revoke(session, prefix=tok.prefix)
    assert n == 1
    session.refresh(tok)
    assert tok.revoked_at is not None


def test_token_revoke_no_match_returns_zero(session: Session) -> None:
    assert token_revoke(session, prefix="missing!") == 0


def test_main_refuses_when_schema_missing(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    """CLI must NOT silently create tables. On an empty DB it should
    exit with a clear message pointing the operator at Alembic."""
    import os
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    from aimdware_backend import db as _db

    previous_engine = _db._engine  # noqa: SLF001 - test must isolate process-wide engine
    try:
        monkeypatch.setattr(settings.settings, "database_url", f"sqlite:///{db_path}")
        _db._engine = None  # noqa: SLF001 - reset process-wide engine for this CLI test
        from aimdware_backend.admin_cli import main as cli_main

        rc = cli_main(["user", "list"])
        assert rc == 2
        captured = capsys.readouterr()
        assert "alembic upgrade head" in captured.err
    finally:
        created_engine = _db._engine  # noqa: SLF001 - close temporary test engine before unlink
        if created_engine is not None and created_engine is not previous_engine:
            created_engine.dispose()
        _db._engine = previous_engine  # noqa: SLF001 - restore shared engine after CLI test
        os.unlink(db_path)


def test_schema_probe_rejects_legacy_create_all_schema() -> None:
    """A metadata.create_all DB has core tables but is not an Alembic-owned
    production schema, so the CLI must refuse it."""
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    assert _schema_exists(engine) is False


# --- student_id + email derivation ---------------------------------------


def test_user_create_stores_student_id(session: Session) -> None:
    u = user_create(session, jaccount="x", email="x@e", display_name="X", student_id="5190100009")
    assert u.student_id == "5190100009"


def test_user_create_student_id_defaults_none(session: Session) -> None:
    u = user_create(session, jaccount="y", email="y@e", display_name="Y")
    assert u.student_id is None


def test_derive_email_from_jaccount() -> None:
    assert derive_email("alice") == "alice@sjtu.edu.cn"
    assert derive_email("bob", domain="example.edu") == "bob@example.edu"


# --- batch (CSV) operations -----------------------------------------------


def test_batch_user_create_inserts_with_derived_email_and_student_id(
    session: Session,
) -> None:
    rows = [
        RosterRow(name="张三", student_id="5190100001", jaccount="zhangsan"),
        RosterRow(name="李四", student_id="5190100002", jaccount="lisi"),
    ]
    res = batch_user_create(session, rows)
    assert [r["status"] for r in res] == ["created", "created"]
    z = user_get(session, "zhangsan")
    assert z.email == "zhangsan@sjtu.edu.cn"
    assert z.student_id == "5190100001"
    assert z.display_name == "张三"


def test_batch_user_create_existing_jaccount_is_exists_not_error(
    session: Session,
) -> None:
    user_create(session, jaccount="dup", email="dup@sjtu.edu.cn", display_name="Dup")
    res = batch_user_create(session, [RosterRow(name="Dup", student_id="5", jaccount="dup")])
    assert res[0]["status"] == "exists"


def test_batch_enroll_enrolls_then_reports_exists(session: Session) -> None:
    course_create(session, code="C1", title="t", semester="s")
    user_create(session, jaccount="a1", email="a1@e", display_name="A1")
    row = RosterRow(name="A1", student_id="5", jaccount="a1")
    assert (
        batch_enroll(session, [row], course_code="C1", role=Role.student)[0]["status"] == "enrolled"
    )
    assert (
        batch_enroll(session, [row], course_code="C1", role=Role.student)[0]["status"] == "exists"
    )


def test_batch_enroll_missing_user_is_error(session: Session) -> None:
    course_create(session, code="C2", title="t", semester="s")
    res = batch_enroll(
        session,
        [RosterRow(name="Ghost", student_id="5", jaccount="ghost")],
        course_code="C2",
        role=Role.student,
    )
    assert res[0]["status"] == "error"
    assert "error" in res[0]


def test_batch_token_issue_returns_plaintext_and_prefix(session: Session) -> None:
    user_create(session, jaccount="t1", email="t1@e", display_name="T1")
    res = batch_token_issue(session, [RosterRow(name="T1", student_id="5", jaccount="t1")])
    assert res[0]["status"] == "issued"
    assert res[0]["plaintext"].startswith("st_")
    assert res[0]["prefix"] == res[0]["plaintext"][:8]


def test_revoke_tokens_for_user_revokes_all_active(session: Session) -> None:
    user_create(session, jaccount="r1", email="r1@e", display_name="R1")
    token_issue(session, jaccount="r1")
    n = revoke_tokens_for_user(session, "r1")
    assert n == 1
    active = session.exec(
        select(StudentToken).where(StudentToken.revoked_at.is_(None))  # type: ignore[union-attr]
    ).all()
    assert active == []


def test_batch_token_revoke_reports_count(session: Session) -> None:
    user_create(session, jaccount="r2", email="r2@e", display_name="R2")
    token_issue(session, jaccount="r2")
    res = batch_token_revoke(session, [RosterRow(name="R2", student_id="5", jaccount="r2")])
    assert res[0]["status"] == "revoked"
    assert res[0]["revoked"] == 1
