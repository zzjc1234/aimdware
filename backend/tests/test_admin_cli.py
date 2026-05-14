"""Tests for the TT admin CLI's importable command functions."""

from __future__ import annotations

import hashlib

from sqlmodel import Session, select

from aimdware_backend.admin_cli import (
    course_create,
    enroll,
    token_issue,
    token_revoke,
    user_create,
    user_get,
)
from aimdware_backend.models import Course, Enrollment, Role, StudentToken, User


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
