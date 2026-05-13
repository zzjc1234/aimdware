"""SQLModel schemas for the aimdware backend."""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import BigInteger, Column, Index, JSON, LargeBinary, UniqueConstraint
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    """Return the current UTC time (timezone-aware)."""
    return datetime.now(timezone.utc)


class Role(str, Enum):
    student = "student"
    admin = "admin"


class BlobStatus(str, Enum):
    """Lifecycle of the per-record blob on jbox.

    Note on multi-turn sessions: the blob file is keyed by `session_id`
    and overwritten on every turn. So `uploaded` on a record means
    "the router successfully PUT a snapshot for this turn at the time" —
    NOT "this record's `blob_hash` matches what's currently on jbox".
    For all turns except the latest of their session, the on-jbox bytes
    have since moved on; verification will report `verified=false` with
    `is_latest_turn=false`. Use /admin/session/<id>/payload for the
    canonical "verify the session's current blob" workflow.
    """

    pending = "pending"
    uploaded = "uploaded"
    verified = "verified"
    tampered = "tampered"
    missing = "missing"


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    display_name: str
    email: str = Field(unique=True, index=True)
    jaccount: str = Field(unique=True, index=True)
    is_active: bool = Field(default=True)
    created_at: datetime = Field(default_factory=utcnow)


class Course(SQLModel, table=True):
    __tablename__ = "courses"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    code: str = Field(unique=True, index=True)
    title: str
    semester: str
    created_at: datetime = Field(default_factory=utcnow)


class Enrollment(SQLModel, table=True):
    __tablename__ = "enrollments"

    user_id: UUID = Field(foreign_key="users.id", primary_key=True)
    course_id: UUID = Field(foreign_key="courses.id", primary_key=True)
    role: Role
    created_at: datetime = Field(default_factory=utcnow)


class StudentToken(SQLModel, table=True):
    __tablename__ = "student_tokens"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", index=True)
    token_hash: bytes = Field(sa_column=Column(LargeBinary))
    prefix: str
    created_at: datetime = Field(default_factory=utcnow)
    revoked_at: Optional[datetime] = None

    # Partial unique index — at most one active token per user — is added
    # in the Alembic migration. SQLModel can't express partial uniqueness
    # natively, and we don't want it shadowing the index below.
    __table_args__ = (Index("ix_student_tokens_user", "user_id"),)


class ContextRecord(SQLModel, table=True):
    __tablename__ = "context_records"
    # Encode the invariant: turn_count is unique within a session. Two
    # routers writing concurrent records for the same session can never
    # silently collide on a tiebreaker; the DB will reject the duplicate.
    __table_args__ = (
        UniqueConstraint(
            "session_id", "turn_count", name="ux_context_records_session_turn"
        ),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", index=True)
    course_id: UUID = Field(foreign_key="courses.id", index=True)
    # Session this record belongs to. Multiple records can share a session
    # (each agent turn = one record, all sharing one session_id and one
    # blob_uri). New session for one-off chats too — they're a session of 1.
    session_id: UUID = Field(index=True)
    turn_count: int = Field(default=1)
    ts: datetime = Field(default_factory=utcnow, index=True)
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    router_version: str
    client_meta: dict = Field(default_factory=dict, sa_column=Column(JSON))

    blob_uri: str
    blob_hash: bytes = Field(sa_column=Column(LargeBinary))
    blob_size: int = Field(sa_column=Column(BigInteger))
    blob_status: BlobStatus = Field(default=BlobStatus.pending, index=True)
    blob_verified_at: Optional[datetime] = None
