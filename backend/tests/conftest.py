"""Shared pytest fixtures."""
from __future__ import annotations

import pytest
from sqlmodel import Session, SQLModel, create_engine
from sqlalchemy import Engine, text
from sqlalchemy.pool import StaticPool

# Importing models registers them with SQLModel.metadata so create_all
# sees every table even if a test only uses one of them.
from aimdware_backend import models  # noqa: F401


@pytest.fixture
def engine() -> Engine:
    """Fresh in-memory SQLite for each test.

    Uses StaticPool so the single in-memory database is shared across all
    Session() calls on the engine (required for tests that read in one
    session what another session wrote).
    """
    e = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(e)
    # SQLModel.metadata can't express the partial unique index that
    # enforces "one active token per user" — that DDL lives only in
    # Alembic 0001. Mirror it here so tests see the same constraints as
    # production. Without this, tests pass vacuously on token-uniqueness
    # invariants that prod would reject.
    with e.begin() as conn:
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS "
                "ux_student_tokens_active_per_user "
                "ON student_tokens (user_id) WHERE revoked_at IS NULL"
            )
        )
    return e


@pytest.fixture
def session(engine: Engine):
    with Session(engine) as s:
        yield s
