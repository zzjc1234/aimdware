"""Token-hash bearer auth for /ingest/*."""
from __future__ import annotations

import hashlib
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlmodel import Session, select

from aimdware_backend.db import get_session
from aimdware_backend.models import StudentToken, User


def _hash_token(plaintext: str) -> bytes:
    return hashlib.sha256(plaintext.encode("utf-8")).digest()


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def authenticate_student(
    authorization: Annotated[str | None, Header()] = None,
    session: Annotated[Session, Depends(get_session)] = ...,  # type: ignore[assignment]
) -> User:
    """Resolve the Bearer token to a User row.

    Hashes the plaintext, looks up an active StudentToken, returns the
    associated User. Raises 401 on any miss (missing header, malformed
    header, unknown token, revoked token).
    """
    plaintext = _extract_bearer(authorization)
    if plaintext is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or malformed bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    digest = _hash_token(plaintext)
    row = session.exec(
        select(StudentToken)
        .where(StudentToken.token_hash == digest)
        .where(StudentToken.revoked_at.is_(None))  # type: ignore[union-attr]
    ).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = session.get(User, row.user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="user inactive",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user
