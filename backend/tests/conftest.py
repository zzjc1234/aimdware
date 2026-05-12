"""Shared pytest fixtures."""
from __future__ import annotations

import pytest
from sqlmodel import Session, SQLModel, create_engine
from sqlalchemy import Engine
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
    return e


@pytest.fixture
def session(engine: Engine):
    with Session(engine) as s:
        yield s
