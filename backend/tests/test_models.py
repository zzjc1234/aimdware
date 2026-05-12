"""TDD: SQLModel schemas."""
from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from aimdware_backend.models import (
    BlobStatus,
    ContextRecord,
    Course,
    Enrollment,
    Role,
    StudentToken,
    User,
)


def test_user_round_trip(session: Session) -> None:
    u = User(display_name="Zhang San", email="z@sjtu.edu.cn", jaccount="zhangsan")
    session.add(u)
    session.commit()
    session.refresh(u)

    assert u.id is not None
    assert u.is_active is True
    assert u.created_at is not None

    fetched = session.exec(select(User).where(User.jaccount == "zhangsan")).one()
    assert fetched.email == "z@sjtu.edu.cn"


def test_user_email_unique(session: Session) -> None:
    session.add(User(display_name="A", email="dup@x", jaccount="a"))
    session.commit()
    session.add(User(display_name="B", email="dup@x", jaccount="b"))
    with pytest.raises(IntegrityError):
        session.commit()


def test_user_jaccount_unique(session: Session) -> None:
    session.add(User(display_name="A", email="a@x", jaccount="dup"))
    session.commit()
    session.add(User(display_name="B", email="b@x", jaccount="dup"))
    with pytest.raises(IntegrityError):
        session.commit()


def test_course_code_unique(session: Session) -> None:
    session.add(
        Course(code="ECE4721J", title="Intro to Systems", semester="2026-spring")
    )
    session.commit()
    session.add(Course(code="ECE4721J", title="dup", semester="2026-fall"))
    with pytest.raises(IntegrityError):
        session.commit()


def test_enrollment_composite_pk(session: Session) -> None:
    user = User(display_name="A", email="a@x", jaccount="a")
    course = Course(code="C1", title="t", semester="s")
    session.add_all([user, course])
    session.commit()

    e1 = Enrollment(user_id=user.id, course_id=course.id, role=Role.student)
    session.add(e1)
    session.commit()

    # Same (user, course) pair → composite PK violation
    e2 = Enrollment(user_id=user.id, course_id=course.id, role=Role.admin)
    session.add(e2)
    with pytest.raises(IntegrityError):
        session.commit()


def test_student_token_persists_hash_bytes(session: Session) -> None:
    user = User(display_name="A", email="a@x", jaccount="a")
    session.add(user)
    session.commit()

    digest = b"\xde\xad\xbe\xef" * 8
    tok = StudentToken(user_id=user.id, token_hash=digest, prefix="st_test01")
    session.add(tok)
    session.commit()
    session.refresh(tok)

    assert tok.id is not None
    assert tok.revoked_at is None
    assert tok.token_hash == digest


def test_context_record_persists_with_blob_metadata(session: Session) -> None:
    user = User(display_name="A", email="a@x", jaccount="a")
    course = Course(code="C1", title="t", semester="s")
    session.add_all([user, course])
    session.commit()

    rec = ContextRecord(
        user_id=user.id,
        course_id=course.id,
        model="gpt-4o-mini",
        prompt_tokens=10,
        completion_tokens=20,
        router_version="0.0.0",
        client_meta={"agent": "cline"},
        blob_uri="aimdware/C1/abc.json",
        blob_hash=b"\x00" * 32,
        blob_size=12345,
    )
    session.add(rec)
    session.commit()
    session.refresh(rec)

    assert rec.id is not None
    assert rec.ts is not None
    assert rec.blob_status == BlobStatus.pending
    assert rec.client_meta == {"agent": "cline"}


def test_context_record_id_is_pk_unique(session: Session) -> None:
    user = User(display_name="A", email="a@x", jaccount="a")
    course = Course(code="C1", title="t", semester="s")
    session.add_all([user, course])
    session.commit()

    rec_id = uuid4()
    base = dict(
        user_id=user.id,
        course_id=course.id,
        model="gpt",
        router_version="0.0.0",
        blob_uri="x.json",
        blob_hash=b"\x00" * 32,
        blob_size=1,
    )
    session.add(ContextRecord(id=rec_id, **base))
    session.commit()
    session.add(ContextRecord(id=rec_id, **base))
    with pytest.raises(IntegrityError):
        session.commit()
