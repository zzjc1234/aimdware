"""Admin endpoints — TT-facing, shared-secret bearer auth."""

from __future__ import annotations

import hashlib
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

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


def _latest_record_for_session(session: Session, session_id: UUID) -> ContextRecord | None:
    # turn_count is monotonically increasing within a session (enforced by
    # a UNIQUE(session_id, turn_count) DB constraint), but we still tiebreak
    # on ts.desc() defensively. If two records ever did share a turn_count,
    # the latest-by-wall-clock is the one we want for verification.
    return session.exec(
        select(ContextRecord)
        .where(ContextRecord.session_id == session_id)
        .order_by(
            ContextRecord.turn_count.desc(),  # type: ignore[union-attr]
            ContextRecord.ts.desc(),  # type: ignore[union-attr]
        )
    ).first()


async def _fetch_and_verify(record: ContextRecord, reader: JboxReader) -> tuple[bytes, bool]:
    try:
        bytes_ = await reader.get(record.blob_uri)
    except JboxNotFound:
        raise HTTPException(status_code=404, detail="blob missing from jbox") from None
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"jbox fetch failed: {exc}") from None
    actual = hashlib.sha256(bytes_).digest()
    return bytes_, actual == record.blob_hash


@router.get("/context/{record_id}/payload")
async def get_payload(
    record_id: UUID,
    session: Annotated[Session, Depends(get_session)],
    reader: Annotated[JboxReader, Depends(get_jbox_reader)],
) -> dict[str, Any]:
    """Fetch the captured payload from jbox and verify its hash.

    Note for sessions with multiple turns: the blob on jbox is the
    *latest* turn's snapshot. A `record_id` that isn't the latest turn
    will show `is_latest_turn=false` and `verified=false` — its stored
    hash represents the snapshot at the time of THAT turn, which no
    longer exists on jbox. For session-level verification call
    `/admin/session/<session_id>/payload`.
    """
    record = session.get(ContextRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="record not found")

    latest = _latest_record_for_session(session, record.session_id)
    is_latest_turn = latest is not None and latest.id == record.id

    bytes_, verified = await _fetch_and_verify(record, reader)
    actual_hex = hashlib.sha256(bytes_).hexdigest()
    return {
        "record_id": str(record.id),
        "session_id": str(record.session_id),
        "turn_count": record.turn_count,
        "is_latest_turn": is_latest_turn,
        "blob_uri": record.blob_uri,
        "blob_size_stored": record.blob_size,
        "blob_size_actual": len(bytes_),
        "blob_hash_stored": record.blob_hash.hex(),
        "blob_hash_actual": actual_hex,
        "verified": verified,
        "payload_utf8": bytes_.decode("utf-8", errors="replace"),
    }


@router.get("/session/{session_id}/payload")
async def get_session_payload(
    session_id: UUID,
    session: Annotated[Session, Depends(get_session)],
    reader: Annotated[JboxReader, Depends(get_jbox_reader)],
) -> dict[str, Any]:
    """Fetch the session's current blob from jbox, verify against the
    latest turn's stored hash.

    The blob is overwritten on each turn, so its hash matches the latest
    turn's `blob_hash` (and only that one).
    """
    latest = _latest_record_for_session(session, session_id)
    if latest is None:
        raise HTTPException(status_code=404, detail="session not found")

    bytes_, verified = await _fetch_and_verify(latest, reader)
    actual_hex = hashlib.sha256(bytes_).hexdigest()
    return {
        "session_id": str(session_id),
        "latest_record_id": str(latest.id),
        "turn_count": latest.turn_count,
        "blob_uri": latest.blob_uri,
        "blob_size_stored": latest.blob_size,
        "blob_size_actual": len(bytes_),
        "blob_hash_stored": latest.blob_hash.hex(),
        "blob_hash_actual": actual_hex,
        "verified": verified,
        "payload_utf8": bytes_.decode("utf-8", errors="replace"),
    }
