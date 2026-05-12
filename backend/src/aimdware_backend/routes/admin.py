"""Admin endpoints — TT-facing, shared-secret bearer auth."""
from __future__ import annotations

import hashlib
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from aimdware_backend.admin_auth import authenticate_admin
from aimdware_backend.db import get_session
from aimdware_backend.jbox import JboxNotFound, JboxReader, default_reader
from aimdware_backend.models import ContextRecord


router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(authenticate_admin)],
)


def get_jbox_reader() -> JboxReader:
    """Default jbox reader; overridable in tests via dependency_overrides."""
    return default_reader()


@router.get("/context/{record_id}/payload")
async def get_payload(
    record_id: UUID,
    session: Annotated[Session, Depends(get_session)],
    reader: Annotated[JboxReader, Depends(get_jbox_reader)],
) -> dict[str, Any]:
    """Fetch the captured payload from jbox and verify its hash.

    The backend itself stores no content, just the metadata + the
    sha256 the router promised. This endpoint pulls the bytes from the
    configured Tbox WebDAV endpoint, recomputes sha256, and returns
    everything plus a `verified` flag so the caller knows whether the
    blob has been tampered with since capture.

    The backend does not mutate ContextRecord.blob_status here; that
    transition is reserved for the admin script's explicit verify
    command.
    """
    record = session.get(ContextRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="record not found")

    try:
        bytes_ = await reader.get(record.blob_uri)
    except JboxNotFound:
        raise HTTPException(
            status_code=404, detail="blob missing from jbox"
        ) from None
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"jbox fetch failed: {exc}"
        ) from None

    actual = hashlib.sha256(bytes_).digest()
    verified = actual == record.blob_hash

    return {
        "record_id": str(record.id),
        "blob_uri": record.blob_uri,
        "blob_size_stored": record.blob_size,
        "blob_size_actual": len(bytes_),
        "blob_hash_stored": record.blob_hash.hex(),
        "blob_hash_actual": actual.hex(),
        "verified": verified,
        "payload_utf8": bytes_.decode("utf-8", errors="replace"),
    }
