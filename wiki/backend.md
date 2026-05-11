# Backend

- Python 3.12 + FastAPI + SQLModel + Alembic + PostgreSQL
- Auth: student-token bearer for `/ingest/*`. No sessions, no password
  hashing in v1.

## Ingest API

Caller: student router. Auth: student token in `Authorization: Bearer st_...`.
Write-only — no endpoint returns content.

| Method | Path                                   | Function |
| ------ | -------------------------------------- | -------- |
| `GET`  | `/ingest/health`                       | Unauthenticated liveness probe. |
| `POST` | `/ingest/context`                      | Record one entry. Body: `{ record_id, course_code, blob_hash, blob_uri, blob_size, model, prompt_tokens, completion_tokens, ts, router_version, client_meta }`. Backend resolves `student_id` from the token, resolves `course_id` from `course_code`, verifies `Enrollment(student, course, role=student)` exists, inserts `ContextRecord` with `blob_status = pending`. **Idempotent on `record_id`**: a repeat POST with the same id returns `200` with the existing row (no double insert), provided the body matches; mismatched body → `409 Conflict`. New inserts return `202`. Returns `403` if the student is not enrolled in the named course. |
| `POST` | `/ingest/context/{record_id}/uploaded` | Router calls this after `rclone copy` to the Tbox WebDAV endpoint reports success. Transitions `blob_status` to `uploaded`. Idempotent. |

Blobs never traverse this surface — only the hash, URI, and metadata.

## Datamodel

SQLModel. The full schema is created at v1 time so later HTTP surfaces
can be bolted on without migrations.

```python
from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import BigInteger, Column, Index, JSON, LargeBinary
from sqlmodel import Field, SQLModel


class Role(str, Enum):
    student = "student"
    admin = "admin"      # TT — scoped to the courses where this row exists


class BlobStatus(str, Enum):
    pending = "pending"      # hash recorded; upload not confirmed
    uploaded = "uploaded"    # router confirmed rclone push succeeded
    verified = "verified"    # backend verified hash (post-v1)
    tampered = "tampered"    # hash mismatch (post-v1)
    missing = "missing"      # blob not found in jbox (post-v1)


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    display_name: str
    email: str = Field(unique=True, index=True)
    jaccount: str = Field(unique=True, index=True)
    is_active: bool = Field(default=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Course(SQLModel, table=True):
    __tablename__ = "courses"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    code: str = Field(unique=True, index=True)
    title: str
    semester: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Enrollment(SQLModel, table=True):
    __tablename__ = "enrollments"

    user_id: UUID = Field(foreign_key="users.id", primary_key=True)
    course_id: UUID = Field(foreign_key="courses.id", primary_key=True)
    role: Role
    created_at: datetime = Field(default_factory=datetime.utcnow)


class StudentToken(SQLModel, table=True):
    __tablename__ = "student_tokens"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", index=True)
    token_hash: bytes = Field(sa_column=Column(LargeBinary))
    prefix: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    revoked_at: Optional[datetime] = None

    # Partial unique index on (user_id) WHERE revoked_at IS NULL
    # is created in the Alembic migration to enforce one active token per
    # student. Course context is supplied per-request in /ingest/context.
    __table_args__ = (Index("ix_student_tokens_user", "user_id"),)


class ContextRecord(SQLModel, table=True):
    __tablename__ = "context_records"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", index=True)
    course_id: UUID = Field(foreign_key="courses.id", index=True)
    ts: datetime = Field(default_factory=datetime.utcnow, index=True)
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    router_version: str
    client_meta: dict = Field(default_factory=dict, sa_column=Column(JSON))

    blob_uri: str
    blob_hash: bytes = Field(sa_column=Column(LargeBinary))
    blob_size: int = Field(sa_column=Column(BigInteger))
    blob_status: BlobStatus = Field(default=BlobStatus.pending, index=True)
    blob_verified_at: Optional[datetime] = None
```

Notes:

- One `StudentToken` per student. Rotation inserts a new row and sets
  `revoked_at` on the old; the partial unique index enforces "at most
  one active token per student".
- Course context per ingest is supplied via `course_code` in the request
  body. Backend resolves the course and verifies the student is enrolled
  in it (`role = student`); otherwise rejects with 403.
- `BlobStatus` reaches `uploaded` from the router's own POST. The TT's
  `records fetch --verify` writes `verified` / `tampered` / `missing`
  when they inspect a record.
- `ContextRecord.id` is the router-generated idempotency key. The PK
  uniqueness on `id` plus the API's "match existing row → 200, mismatch
  → 409" semantics make `POST /ingest/context` safely retryable.
- `blob_size` uses `BIGINT` (not `INTEGER`) — INTEGER tops out at 2 GB
  and runaway blobs should fail loudly, not silently truncate.

## Security

- **Token → student attribution.** The token identifies the student;
  the router cannot impersonate someone else by tampering with the body.
- **Course is verified per request.** Backend rejects ingest for any
  course the student is not enrolled in.
- **Write-only ingest.** No HTTP read surface, so a stolen student
  token writes at most fake records for that student's enrolled courses.
- **No content on the backend.** Postgres holds metadata + hash + URI.
  A full DB compromise yields no student work.
- **Constant-time compare** on student-token validation; tokens never
  in logs.
