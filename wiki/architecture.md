# Architecture

## System overview

v1 ships three components: a **backend** (Python/FastAPI), a **router**
(Bun single-binary on the student's machine), and an **admin CLI**
(`aimdware-admin`, ships inside the backend package). Two roles:
**student** and **admin** (TT).

```
  TT  ─── aimdware-admin ────► backend DB           (user/course/token mgmt)
       └── /admin/* HTTP ─────► backend ─── WebDAV ─► student's jbox  (audit reads)

  Student                    ┌──────────────────┐
    (local)  ◄── /v1/chat ──►│  router (binary) │── /v1/chat ──► upstream LLM
                             │                  │── /ingest/* ──► backend
                             │                  │── PUT       ──► student's WebDAV
                             └──────────────────┘                 (jbox / nextcloud /
                                                                   minio / any compliant)
```

The router is the only piece that sees the student's LLM credential.
The backend stores **no payload content** — only metadata, hash, and
the WebDAV URI.

## Components

**Backend.** SQLite (dev) / Postgres (prod) + FastAPI. Two HTTP
surfaces: `/ingest/*` (student-token auth) and `/admin/*` (shared-secret
auth). The admin endpoints proxy reads from the student's WebDAV using
a backend-side reader account (in production this account would have
read scope on student folders; pre-prod uses the same admin/admin
local Tbox).

**Router.** Single Bun binary on the student's machine. Listens for
OpenAI Chat Completions at `localhost`, forwards to a
student-configured upstream with the student's LLM key, classifies
each request into a session (prefix-extension match), captures the
full request body + response into a per-session blob, and asynchronously
posts metadata to the backend + PUTs the blob to the student's WebDAV.

**Admin CLI.** TT-side Python CLI (`aimdware-admin`). Manages users /
courses / enrollments / tokens by talking directly to the backend DB;
fetches blobs from WebDAV by calling `/admin/.../payload` over HTTP.

## Credentials

| Credential | Held by | Used for |
|---|---|---|
| `student_token` | student (router config, mode 600) | router → backend `/ingest/*` |
| upstream LLM api_key | same | router → upstream chat completions |
| WebDAV user/pass | same | router → student's jbox (PUT) |
| `AIMDWARE_ADMIN_SECRET` | backend host env | TT-tooling → backend `/admin/*` |
| WebDAV reader account | backend host env | backend → WebDAV (audit reads) |

One `student_token` per student; the course context is sent in each
ingest request body (`course_code` + `assignment`). The backend
verifies the student is enrolled in that course before recording.
Rotating the token revokes all further uploads for the student across
every course; LLM provider and WebDAV credentials are the student's
own to rotate.

## Storage split

- **Backend DB**: metadata + hash + URI only. ~500 B per row. 20
  courses × 100 active students × 50 req/day × 100 days ≈ 5 GB / sem.
- **Student's WebDAV** (jbox or similar): full conversation blobs as
  pretty-printed JSON. Path:
  `/aimdware/<course>/<assignment>/<session_id>.json`. **One file per
  session** (Design A): a 50-turn agent conversation produces one file
  that grows monotonically with the conversation, not 50 files. See
  [llm-client.md → "Session identification"](llm-client.md).
- **Tamper detection** by sha256, recorded at capture and re-verified
  on demand via `/admin/context/<id>/payload`.

## Roles and RBAC

`enrollments(user_id, course_id, role)` with `role` in `{student, admin}`.
v1 enforcement is **soft and operational** — `/admin/*` is gated by a
shared secret, not by per-user authorization. Anyone with the admin
secret can read every course. Per-course admin scoping is a documented
TODO; see [admin-script.md](admin-script.md).

## Tech stack

| Component | Stack |
|---|---|
| Backend | Python 3.13 + FastAPI + SQLModel + Alembic + sqlite/Postgres |
| Router | Bun (compiled single binary per OS) |
| Admin CLI | Python, ships with backend package |

Wire format is OpenAI Chat Completions only. Subscription auth (Codex,
Copilot) and Anthropic-format inbound are not in scope for v1.

## Key design choices

**Session-keyed blobs (Design A)** — one jbox file per logical
session, overwritten on each turn. Avoids O(N²) storage for multi-turn
conversations. See [llm-client.md](llm-client.md) for the matching
algorithm.

**Atomic single-flight in the outbox** — `UPDATE … RETURNING` lets
multiple worker processes share one `queue.db` without double-uploads.

**The router persists `request` and `response` verbatim** — not a
hand-picked subset. Anything the model saw (system prompt, messages,
tools, sampling params, vendor-specific fields) is in the blob. New
OpenAI parameters don't need a code change in the router.

**WebDAV-agnostic** — the router speaks standard PUT + MKCOL +
PROPFIND. jbox via Tbox is the reference setup; any compliant WebDAV
works.

See [design-notes.md](design-notes.md) for what we learned running
this against real agent platforms (opencode + plugins).
