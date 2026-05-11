# Architecture

## System overview

v1 ships three components: a **backend** (Python/FastAPI/Postgres), an
**LLM client** (Bun single binary on the student's machine), and an
**admin script** (`aimdware-admin` Python CLI for the TT). Two roles:
**student** and **admin** (a.k.a. TT). Admin authority is scoped per
course via `enrollments` — being an admin in CS101 grants no access to
CS201's data.

```
                 ┌───────────────────────┐
                 │  TT (admin)           │ ──── aimdware-admin CLI
                 └───────────────────────┘      (direct Postgres) +
                                                jbox via own jaccount
                 ┌───────────────────────┐
                 │  Student              │ ──── upload via router
                 └───────────────────────┘
                                              ▼
                          ┌──────────────────────────┐      ┌───────────────┐
                          │  Backend (ingest only)   │◀─────│ Client router │
                          │  metadata + hash only    │      │ student's     │
                          └──────────────────────────┘      │ localhost     │
                                                            └───┬───────┬───┘
                                                                │       │
                                                          blob  │       │ chat
                                                         (JSON) │       │ completion
                                                                ▼       ▼
                                                ┌──────────────────────┐    ┌──────────────┐
                                                │ Student's jbox       │    │ Upstream LLM │
                                                │ (1 TB/student quota) │    │ (OpenAI etc.)│
                                                └──────────────────────┘    └──────────────┘
```

The router is the only piece that sees the student's LLM credential.
The backend stores no payload content — only metadata, hash, and the
jbox URI.

## Components

**Backend.** Postgres + FastAPI. Exposes `/ingest/*` only (course-token
auth).

**LLM client.** Single binary on the student's machine. Exposes an
OpenAI-compatible Chat Completions endpoint on `localhost`, forwards to
a student-configured upstream with the student's LLM key, sends
metadata + sha256 to the backend, and uploads the response JSON to the
student's jbox via `rclone` against a locally-running Tbox WebDAV
endpoint.

**Admin script.** TT-side Python CLI (`aimdware-admin`). Manages users
/ courses / enrollments / tokens by talking directly to Postgres;
fetches blobs from jbox for inspection.

## Credentials

| Credential          | Held by | Used for                      |
| ------------------- | ------- | ----------------------------- |
| Course token        | student | router -> backend ingest auth |
| Student LLM API key | student | router -> upstream LLM        |

The router holds no jbox secret — auth lives in the student's locally
running Tbox (WebDAV gateway to jbox), already bound to their jaccount.
The backend holds no jbox credential in v1. Course tokens are
per-`(student, course)`; rotating one disables further uploads for that
pair without affecting LLM access.

## Roles and RBAC

`enrollments(user_id, course_id, role)` with `role ∈ {student, admin}`.
An admin enrollment grants TT-level access **only to that course**;
there is no global admin flag. v1 enforcement is soft (the admin
script filters operations by the caller's admin enrollments); raw SQL
bypasses it.

## Storage split

- Postgres: metadata + hash + URI only. ~500 B per row; for 20 courses
  × 100 active students × 50 req/day × 100 days ≈ 5 GB / semester.
- jbox (per student): full JSON payloads, addressed by record id.
- Tamper detection by hash.

## Tech stack

| Component | Stack                                                 |
| --------- | ----------------------------------------------------- |
| Backend   | Python 3.12 + FastAPI + SQLModel + Alembic + Postgres |
| Client    | Bun (compiled single binary)                          |

Wire format is OpenAI Chat Completions only. Subscription auth and
Anthropic-format inbound are not in scope.
