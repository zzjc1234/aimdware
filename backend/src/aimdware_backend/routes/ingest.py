"""Ingest API — the only HTTP surface the student router talks to."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlmodel import Session, select

from aimdware_backend.auth import authenticate_student
from aimdware_backend.db import get_session
from aimdware_backend.models import (
    BlobStatus,
    ContextRecord,
    Course,
    Enrollment,
    Role,
    User,
)


router = APIRouter(prefix="/ingest", tags=["ingest"])


class IngestContextBody(BaseModel):
    """Body of POST /ingest/context — metadata + hash only, no blob bytes."""

    model_config = ConfigDict(extra="forbid")

    record_id: UUID
    course_code: str
    blob_hash: str  # hex-encoded sha256
    blob_uri: str
    blob_size: int = Field(ge=0)
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    ts: datetime
    router_version: str
    client_meta: dict[str, Any] = Field(default_factory=dict)


def _resolve_enrolled_course(
    session: Session, user: User, course_code: str
) -> Course:
    course = session.exec(select(Course).where(Course.code == course_code)).first()
    if course is None:
        raise HTTPException(status_code=404, detail="course not found")
    enrol = session.exec(
        select(Enrollment).where(
            Enrollment.user_id == user.id,
            Enrollment.course_id == course.id,
            Enrollment.role == Role.student,
        )
    ).first()
    if enrol is None:
        raise HTTPException(
            status_code=403, detail="not enrolled as student in this course"
        )
    return course


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/context")
def post_context(
    body: IngestContextBody,
    response: Response,
    user: Annotated[User, Depends(authenticate_student)],
    session: Annotated[Session, Depends(get_session)],
) -> dict[str, str]:
    """Record a context entry.

    Idempotent on `record_id`: a replay with matching body returns 200;
    matching id with different body returns 409; a fresh insert returns 202.
    """
    course = _resolve_enrolled_course(session, user, body.course_code)

    digest = bytes.fromhex(body.blob_hash)
    existing = session.get(ContextRecord, body.record_id)
    if existing is not None:
        same = (
            existing.blob_hash == digest
            and existing.blob_uri == body.blob_uri
            and existing.blob_size == body.blob_size
            and existing.user_id == user.id
            and existing.course_id == course.id
        )
        if not same:
            raise HTTPException(
                status_code=409,
                detail="record_id matches existing row with different content",
            )
        response.status_code = status.HTTP_200_OK
        return {"id": str(existing.id), "status": "exists"}

    record = ContextRecord(
        id=body.record_id,
        user_id=user.id,
        course_id=course.id,
        ts=body.ts,
        model=body.model,
        prompt_tokens=body.prompt_tokens,
        completion_tokens=body.completion_tokens,
        router_version=body.router_version,
        client_meta=body.client_meta,
        blob_uri=body.blob_uri,
        blob_hash=digest,
        blob_size=body.blob_size,
    )
    session.add(record)
    session.commit()
    response.status_code = status.HTTP_202_ACCEPTED
    return {"id": str(record.id), "status": "created"}


@router.post("/context/{record_id}/uploaded", status_code=200)
def mark_uploaded(
    record_id: UUID,
    user: Annotated[User, Depends(authenticate_student)],
    session: Annotated[Session, Depends(get_session)],
) -> dict[str, str]:
    """Mark blob_status uploaded once the router confirms WebDAV PUT.

    Scoped to the caller — only the owning student can mark their own
    records. Idempotent: a second call on an already-uploaded record is
    a no-op.
    """
    record = session.get(ContextRecord, record_id)
    if record is None or record.user_id != user.id:
        raise HTTPException(status_code=404, detail="record not found")
    if record.blob_status == BlobStatus.pending:
        record.blob_status = BlobStatus.uploaded
        session.add(record)
        session.commit()
    return {"id": str(record.id), "status": record.blob_status.value}
