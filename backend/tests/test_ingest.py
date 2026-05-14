"""TDD: ingest endpoints."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlmodel import Session

from aimdware_backend.db import get_session
from aimdware_backend.main import create_app
from aimdware_backend.models import Course, Enrollment, Role, StudentToken, User


def _hash(plaintext: str) -> bytes:
    return hashlib.sha256(plaintext.encode()).digest()


@pytest.fixture
def client(engine: Engine, session: Session) -> TestClient:
    app = create_app()

    def override_session():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = override_session
    return TestClient(app)


@pytest.fixture
def enrolled_student(session: Session) -> tuple[str, User, Course]:
    """Seed a user enrolled in ECE4721J + an active token. Returns (plaintext, user, course)."""
    user = User(display_name="Zhang San", email="z@x", jaccount="zhangsan")
    course = Course(code="ECE4721J", title="Intro to Systems", semester="2026-spring")
    session.add_all([user, course])
    session.commit()
    session.add(Enrollment(user_id=user.id, course_id=course.id, role=Role.student))
    plaintext = "st_ENROLLED_STUDENT_TOKEN"
    session.add(StudentToken(user_id=user.id, token_hash=_hash(plaintext), prefix=plaintext[:8]))
    session.commit()
    return plaintext, user, course


def _body(course_code: str = "ECE4721J", **overrides) -> dict:
    base = {
        "record_id": str(uuid4()),
        "session_id": str(uuid4()),
        "turn_count": 1,
        "course_code": course_code,
        "assignment": "hw1",
        "blob_hash": "ab" * 32,
        "blob_uri": "aimdware/ECE4721J/hw1/abc.json",
        "blob_size": 1234,
        "model": "gpt-4o-mini",
        "prompt_tokens": 10,
        "completion_tokens": 20,
        "ts": datetime.now(UTC).isoformat(),
        "router_version": "0.0.0",
        "client_meta": {"agent": "cline"},
    }
    base.update(overrides)
    return base


# --------- /ingest/health ---------


def test_health_is_unauthenticated(client: TestClient) -> None:
    r = client.get("/ingest/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# --------- /ingest/context happy paths ---------


def test_post_context_creates_with_202(
    client: TestClient, enrolled_student: tuple[str, User, Course]
) -> None:
    plaintext, _, _ = enrolled_student
    body = _body()
    r = client.post(
        "/ingest/context",
        json=body,
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert r.status_code == 202
    assert r.json()["id"] == body["record_id"]
    assert r.json()["status"] == "created"


def test_post_context_idempotent_replay_returns_200(
    client: TestClient, enrolled_student: tuple[str, User, Course]
) -> None:
    plaintext, _, _ = enrolled_student
    body = _body()
    h = {"Authorization": f"Bearer {plaintext}"}
    r1 = client.post("/ingest/context", json=body, headers=h)
    assert r1.status_code == 202
    r2 = client.post("/ingest/context", json=body, headers=h)
    assert r2.status_code == 200
    assert r2.json()["status"] == "exists"


def test_post_context_mismatched_body_returns_409(
    client: TestClient, enrolled_student: tuple[str, User, Course]
) -> None:
    plaintext, _, _ = enrolled_student
    body = _body()
    h = {"Authorization": f"Bearer {plaintext}"}
    assert client.post("/ingest/context", json=body, headers=h).status_code == 202

    body2 = dict(body)
    body2["blob_hash"] = "cd" * 32  # different content for same record_id
    r = client.post("/ingest/context", json=body2, headers=h)
    assert r.status_code == 409


# --------- /ingest/context auth + scope ---------


def test_post_context_missing_auth_is_401(client: TestClient) -> None:
    r = client.post("/ingest/context", json=_body())
    assert r.status_code == 401


def test_post_context_unknown_course_is_404(
    client: TestClient, enrolled_student: tuple[str, User, Course]
) -> None:
    plaintext, _, _ = enrolled_student
    r = client.post(
        "/ingest/context",
        json=_body(course_code="NOSUCHCOURSE"),
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert r.status_code == 404


def test_post_context_not_enrolled_is_403(
    client: TestClient, enrolled_student: tuple[str, User, Course], session: Session
) -> None:
    plaintext, _, _ = enrolled_student
    other = Course(code="OTHER1", title="t", semester="s")
    session.add(other)
    session.commit()

    r = client.post(
        "/ingest/context",
        json=_body(course_code="OTHER1"),
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert r.status_code == 403


# --------- /ingest/context/{id}/uploaded ---------


def test_mark_uploaded_transitions_status(
    client: TestClient, enrolled_student: tuple[str, User, Course]
) -> None:
    plaintext, _, _ = enrolled_student
    body = _body()
    h = {"Authorization": f"Bearer {plaintext}"}
    client.post("/ingest/context", json=body, headers=h)
    r = client.post(f"/ingest/context/{body['record_id']}/uploaded", headers=h)
    assert r.status_code == 200
    assert r.json()["status"] == "uploaded"


def test_mark_uploaded_is_idempotent(
    client: TestClient, enrolled_student: tuple[str, User, Course]
) -> None:
    plaintext, _, _ = enrolled_student
    body = _body()
    h = {"Authorization": f"Bearer {plaintext}"}
    client.post("/ingest/context", json=body, headers=h)
    client.post(f"/ingest/context/{body['record_id']}/uploaded", headers=h)
    r = client.post(f"/ingest/context/{body['record_id']}/uploaded", headers=h)
    assert r.status_code == 200
    assert r.json()["status"] == "uploaded"


def test_mark_uploaded_other_users_record_is_404(
    client: TestClient,
    enrolled_student: tuple[str, User, Course],
    session: Session,
) -> None:
    plaintext, _, _ = enrolled_student
    h = {"Authorization": f"Bearer {plaintext}"}
    body = _body()
    client.post("/ingest/context", json=body, headers=h)

    # Different student token
    other = User(display_name="Other", email="o@x", jaccount="other")
    session.add(other)
    session.commit()
    other_plain = "st_OTHER_USER_TOKEN_xx"
    session.add(
        StudentToken(
            user_id=other.id,
            token_hash=_hash(other_plain),
            prefix=other_plain[:8],
        )
    )
    session.commit()

    r = client.post(
        f"/ingest/context/{body['record_id']}/uploaded",
        headers={"Authorization": f"Bearer {other_plain}"},
    )
    assert r.status_code == 404


def test_mark_uploaded_unknown_id_is_404(
    client: TestClient, enrolled_student: tuple[str, User, Course]
) -> None:
    plaintext, _, _ = enrolled_student
    r = client.post(
        f"/ingest/context/{uuid4()}/uploaded",
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert r.status_code == 404


def test_post_context_duplicate_session_turn_returns_409(
    client: TestClient, enrolled_student: tuple[str, User, Course]
) -> None:
    """A second record on the same (session_id, turn_count) — with a
    different record_id — must be rejected with 409, not a 500.

    This guards the new UNIQUE(session_id, turn_count) DB constraint.
    """
    plaintext, _, _ = enrolled_student
    h = {"Authorization": f"Bearer {plaintext}"}
    sess = str(uuid4())

    body1 = _body()
    body1["session_id"] = sess
    body1["turn_count"] = 1
    r1 = client.post("/ingest/context", json=body1, headers=h)
    assert r1.status_code == 202, r1.text

    body2 = _body()  # new record_id, same session/turn
    body2["session_id"] = sess
    body2["turn_count"] = 1
    r2 = client.post("/ingest/context", json=body2, headers=h)
    assert r2.status_code == 409, r2.text
