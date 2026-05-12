"""TDD: /admin/context/{id}/payload."""
from __future__ import annotations

import hashlib
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlmodel import Session

from aimdware_backend.db import get_session
from aimdware_backend.jbox import JboxNotFound, JboxReader
from aimdware_backend.main import create_app
from aimdware_backend.models import ContextRecord, Course, User
from aimdware_backend.routes.admin import get_jbox_reader
from aimdware_backend.settings import settings


@pytest.fixture(autouse=True)
def _enable_admin_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default to a known admin secret for these tests."""
    monkeypatch.setattr(settings, "admin_secret", "test-admin-secret-xyz")


def _make_client(engine: Engine, reader: JboxReader) -> TestClient:
    app = create_app()

    def override_session():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_jbox_reader] = lambda: reader
    return TestClient(app)


def _seed_record(session: Session, payload: bytes) -> ContextRecord:
    user = User(display_name="A", email="a@x", jaccount="a")
    course = Course(code="ECE4721J", title="t", semester="s")
    session.add_all([user, course])
    session.commit()
    rec = ContextRecord(
        user_id=user.id,
        course_id=course.id,
        model="gpt-4o-mini",
        router_version="0.0.0",
        blob_uri="aimdware/ECE4721J/sample.json",
        blob_hash=hashlib.sha256(payload).digest(),
        blob_size=len(payload),
    )
    session.add(rec)
    session.commit()
    session.refresh(rec)
    return rec


class _StaticReader:
    def __init__(self, payload: bytes | None) -> None:
        self.payload = payload
        self.last_uri: str | None = None

    async def get(self, blob_uri: str) -> bytes:
        self.last_uri = blob_uri
        if self.payload is None:
            raise JboxNotFound(blob_uri)
        return self.payload


class _ErrorReader:
    async def get(self, blob_uri: str) -> bytes:
        raise RuntimeError("upstream Tbox timed out")


def _auth(secret: str = "test-admin-secret-xyz") -> dict[str, str]:
    return {"Authorization": f"Bearer {secret}"}


# --- auth ---


def test_missing_auth_is_401(engine: Engine, session: Session) -> None:
    payload = b'{"hello":"world"}'
    rec = _seed_record(session, payload)
    client = _make_client(engine, _StaticReader(payload))
    r = client.get(f"/admin/context/{rec.id}/payload")
    assert r.status_code == 401


def test_wrong_secret_is_401(engine: Engine, session: Session) -> None:
    payload = b'{"x":1}'
    rec = _seed_record(session, payload)
    client = _make_client(engine, _StaticReader(payload))
    r = client.get(
        f"/admin/context/{rec.id}/payload", headers=_auth("wrong-secret")
    )
    assert r.status_code == 401


def test_admin_disabled_when_secret_unset(
    engine: Engine, session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b'{"x":1}'
    rec = _seed_record(session, payload)
    monkeypatch.setattr(settings, "admin_secret", "")
    client = _make_client(engine, _StaticReader(payload))
    r = client.get(f"/admin/context/{rec.id}/payload", headers=_auth())
    assert r.status_code == 503


# --- happy path / verify ---


def test_payload_returns_verified_true_when_hash_matches(
    engine: Engine, session: Session
) -> None:
    payload = b'{"request_text": "...", "response_text": "...", "ts": "..."}'
    rec = _seed_record(session, payload)
    reader = _StaticReader(payload)
    client = _make_client(engine, reader)

    r = client.get(f"/admin/context/{rec.id}/payload", headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["verified"] is True
    assert body["record_id"] == str(rec.id)
    assert body["blob_uri"] == rec.blob_uri
    assert body["blob_size_stored"] == len(payload)
    assert body["blob_size_actual"] == len(payload)
    assert body["blob_hash_stored"] == body["blob_hash_actual"]
    assert body["payload_utf8"] == payload.decode("utf-8")
    assert reader.last_uri == rec.blob_uri


def test_payload_returns_verified_false_when_hash_mismatches(
    engine: Engine, session: Session
) -> None:
    real_payload = b"original-bytes"
    rec = _seed_record(session, real_payload)
    tampered = b"tampered-bytes"
    client = _make_client(engine, _StaticReader(tampered))

    r = client.get(f"/admin/context/{rec.id}/payload", headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["verified"] is False
    assert body["blob_hash_stored"] != body["blob_hash_actual"]
    assert body["payload_utf8"] == tampered.decode("utf-8")


def test_payload_returns_404_when_record_unknown(
    engine: Engine, session: Session
) -> None:
    client = _make_client(engine, _StaticReader(b"x"))
    r = client.get(f"/admin/context/{uuid4()}/payload", headers=_auth())
    assert r.status_code == 404


def test_payload_returns_404_when_jbox_missing(
    engine: Engine, session: Session
) -> None:
    rec = _seed_record(session, b"x")
    client = _make_client(engine, _StaticReader(None))  # signals NotFound
    r = client.get(f"/admin/context/{rec.id}/payload", headers=_auth())
    assert r.status_code == 404


def test_payload_returns_502_when_jbox_errors(
    engine: Engine, session: Session
) -> None:
    rec = _seed_record(session, b"x")
    client = _make_client(engine, _ErrorReader())
    r = client.get(f"/admin/context/{rec.id}/payload", headers=_auth())
    assert r.status_code == 502


def test_payload_endpoint_does_not_mutate_status(
    engine: Engine, session: Session
) -> None:
    """Reading the payload is non-destructive — no DB writes."""
    payload = b'{"x":1}'
    rec = _seed_record(session, payload)
    original_status = rec.blob_status

    # Even with mismatched bytes, status must not change.
    client = _make_client(engine, _StaticReader(b"tampered"))
    client.get(f"/admin/context/{rec.id}/payload", headers=_auth())

    session.refresh(rec)
    assert rec.blob_status == original_status
