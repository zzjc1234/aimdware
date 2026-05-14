"""Database engine + session dependency."""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import Engine
from sqlmodel import Session, create_engine

from aimdware_backend.settings import settings

_engine: Engine | None = None


def get_engine() -> Engine:
    """Return the process-wide engine, creating it on first call."""
    global _engine
    if _engine is None:
        _engine = create_engine(
            settings.database_url,
            connect_args=(
                {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
            ),
        )
    return _engine


def get_session() -> Iterator[Session]:
    """FastAPI dependency yielding a per-request session."""
    with Session(get_engine()) as session:
        yield session
