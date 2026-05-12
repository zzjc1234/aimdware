"""TDD: token-hash bearer auth."""
from __future__ import annotations

import hashlib

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlmodel import Session

from aimdware_backend.auth import authenticate_student
from aimdware_backend.db import get_session
from aimdware_backend.models import StudentToken, User


def _hash(plaintext: str) -> bytes:
    return hashlib.sha256(plaintext.encode()).digest()


@pytest.fixture
def app(engine: Engine):
    a = FastAPI()

    @a.get("/me")
    def me(user: User = Depends(authenticate_student)):  # noqa: ANN001
        return {"jaccount": user.jaccount}

    def override_session():
        with Session(engine) as s:
            yield s

    a.dependency_overrides[get_session] = override_session
    return a


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def _seed_user_with_token(session: Session, plaintext: str) -> User:
    user = User(display_name="A", email=f"{plaintext}@x", jaccount=plaintext[:32])
    session.add(user)
    session.commit()
    session.add(
        StudentToken(user_id=user.id, token_hash=_hash(plaintext), prefix=plaintext[:8])
    )
    session.commit()
    return user


def test_valid_bearer_token_authorizes(client: TestClient, session: Session) -> None:
    plaintext = "st_GOOD_TOKEN_001"
    user = _seed_user_with_token(session, plaintext)
    r = client.get("/me", headers={"Authorization": f"Bearer {plaintext}"})
    assert r.status_code == 200
    assert r.json() == {"jaccount": user.jaccount}


def test_missing_header_is_401(client: TestClient) -> None:
    r = client.get("/me")
    assert r.status_code == 401


def test_malformed_header_is_401(client: TestClient) -> None:
    r = client.get("/me", headers={"Authorization": "Basic abc"})
    assert r.status_code == 401


def test_unknown_token_is_401(client: TestClient) -> None:
    r = client.get("/me", headers={"Authorization": "Bearer st_NEVER_EXISTED"})
    assert r.status_code == 401


def test_revoked_token_is_401(client: TestClient, session: Session) -> None:
    plaintext = "st_REVOKED_007"
    _seed_user_with_token(session, plaintext)
    # mark all tokens revoked
    from datetime import datetime, timezone

    for row in session.exec(  # noqa: SLF001 — test
        __import__("sqlmodel").select(StudentToken)
    ).all():
        row.revoked_at = datetime.now(timezone.utc)
        session.add(row)
    session.commit()

    r = client.get("/me", headers={"Authorization": f"Bearer {plaintext}"})
    assert r.status_code == 401


def test_inactive_user_is_401(client: TestClient, session: Session) -> None:
    plaintext = "st_INACTIVE_USER_002"
    user = _seed_user_with_token(session, plaintext)
    user.is_active = False
    session.add(user)
    session.commit()
    r = client.get("/me", headers={"Authorization": f"Bearer {plaintext}"})
    assert r.status_code == 401


def test_one_active_token_per_user_lookup_picks_it(
    client: TestClient, session: Session
) -> None:
    """Multiple historical tokens — only the active one authorizes."""
    user = User(display_name="A", email="a@x", jaccount="multitok")
    session.add(user)
    session.commit()
    from datetime import datetime, timezone

    # old token, revoked
    session.add(
        StudentToken(
            user_id=user.id,
            token_hash=_hash("st_OLD_REVOKED"),
            prefix="st_OLD_R",
            revoked_at=datetime.now(timezone.utc),
        )
    )
    # current active token
    session.add(
        StudentToken(
            user_id=user.id,
            token_hash=_hash("st_NEW_ACTIVE"),
            prefix="st_NEW_A",
        )
    )
    session.commit()

    r_old = client.get("/me", headers={"Authorization": "Bearer st_OLD_REVOKED"})
    assert r_old.status_code == 401

    r_new = client.get("/me", headers={"Authorization": "Bearer st_NEW_ACTIVE"})
    assert r_new.status_code == 200
