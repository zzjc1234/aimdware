"""Shared-secret bearer auth for /admin/* endpoints."""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import Header, HTTPException, status

from aimdware_backend.settings import settings


def authenticate_admin(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    """Gate /admin/* on a constant-time comparison against AIMDWARE_ADMIN_SECRET.

    If the secret is unset, /admin/* is disabled (503) — refuse rather
    than open up.
    """
    if not settings.admin_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="admin endpoints disabled (AIMDWARE_ADMIN_SECRET unset)",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing admin bearer",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization[len("bearer ") :].strip()
    if not hmac.compare_digest(token, settings.admin_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid admin secret",
            headers={"WWW-Authenticate": "Bearer"},
        )
