# TA deployment — step by step

For the teaching team. Takes you from nothing to: a running **backend**
(ingest API + admin audit), a **course + student onboarded**, and
**inspecting a captured blob** — paired with the demo assignment in
[student-setup.md](student-setup.md) (`DEMO101 / demo1`).

What you operate:

```
student routers ── POST /ingest/* (token auth) ─► backend (FastAPI + Postgres)
TT tooling      ── aimdware-admin (direct DB)   ─┘  metadata + sha256 + blob URI only
TT tooling      ── /admin/* (shared-secret) ── WebDAV ─► student jbox (audit reads)
```

The backend **never stores conversation bytes** — only metadata, a
sha256, and the jbox URI. Blobs are fetched live from WebDAV when you
audit. See [backend.md](backend.md) and [threat-model.md](threat-model.md).

---

## 0. Secrets you will manage

| Secret | Env var | Purpose |
|---|---|---|
| Postgres URL | `AIMDWARE_DATABASE_URL` | backend + admin CLI DB access |
| Admin shared secret | `AIMDWARE_ADMIN_SECRET` | bearer for all `/admin/*` endpoints |
| TT WebDAV creds | `AIMDWARE_TBOX_URL` / `_USER` / `_PASS` | fetch blobs from jbox for audit |
| Per-student tokens | (in DB as `sha256`) | minted via `aimdware-admin token issue` |

All backend config is env-driven with the `AIMDWARE_` prefix
(`backend/src/aimdware_backend/settings.py`).

---

## 1. Prerequisites

- **Python ≥ 3.12** and **[uv](https://docs.astral.sh/uv/)**.
- **PostgreSQL** (prod). SQLite works for a quick local trial but use
  Postgres for anything real.
- A **TT-side Tbox** (jBox WebDAV gateway) bound to a jAccount that has
  **read access** to students' `aimdware/` folders — needed only for the
  blob-inspection step (8). The read access is a jBox sharing
  arrangement you set up with students / your institution; this repo
  doesn't manage it.
- A host reachable by students over **HTTPS** for `backend_url`.

---

## 2. Get the code and install

```bash
cd backend
uv sync                 # creates .venv from uv.lock (incl. the aimdware-admin CLI)
```

`uv run <cmd>` runs inside that environment. All commands below are run
from the `backend/` directory.

---

## 3. Provision PostgreSQL

Create a database + user, then point the app at it:

```sql
CREATE USER aimdware WITH PASSWORD '...';
CREATE DATABASE aimdware OWNER aimdware;
```

```bash
export AIMDWARE_DATABASE_URL='postgresql://aimdware:...@localhost:5432/aimdware'
```

> Use a driver SQLAlchemy understands. `postgresql://…` uses the default
> driver; install/select another (e.g. `postgresql+psycopg://…`) if your
> environment needs it.

---

## 4. Apply migrations

Production schema is owned by **Alembic** (not `create_all`):

```bash
uv run alembic upgrade head
```

This creates `users`, `courses`, `enrollments`, `student_tokens`,
`context_records` and the partial/unique indexes. Re-run after pulling
new migrations.

---

## 5. Configure the rest of the environment

Config is read from process env vars **and** from a `.env` file in the
directory you run from (real env vars win over `.env`). Pick whichever
fits your deploy.

**Option A — a `backend/.env` file** (handy for local/dev; it's
gitignored):

```dotenv
# backend/.env  — all keys use the AIMDWARE_ prefix
AIMDWARE_DATABASE_URL=postgresql://aimdware:...@localhost:5432/aimdware
AIMDWARE_ADMIN_SECRET=<48+ random chars>
AIMDWARE_TBOX_URL=http://127.0.0.1:8089
AIMDWARE_TBOX_USER=tt-jaccount
AIMDWARE_TBOX_PASS=...
```

`uv run uvicorn …`, `uv run alembic …` and `uv run aimdware-admin …` all
pick it up automatically when run from `backend/`. Generate the secret
with `python -c 'import secrets; print(secrets.token_urlsafe(48))'`.

> Already exported `AIMDWARE_DATABASE_URL` in steps 3–4? You can drop it
> into `.env` instead and stop exporting it.

**Option B — export / a process manager** (recommended for a real
service):

```bash
export AIMDWARE_ADMIN_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
export AIMDWARE_TBOX_URL='http://127.0.0.1:8089'
export AIMDWARE_TBOX_USER='tt-jaccount'
export AIMDWARE_TBOX_PASS='...'
```

For a systemd service use `EnvironmentFile=/etc/aimdware/backend.env`
(outside the repo), or your secret manager — not shell history. You can
also let uv load any file explicitly: `uv run --env-file /path/to.env …`.

> If `AIMDWARE_ADMIN_SECRET` is empty, every `/admin/*` endpoint returns
> **503** (admin surface disabled) — useful if you want ingest-only.

---

## 6. Run the backend

The app object is `aimdware_backend.main:app`.

```bash
# quick check (single worker, localhost)
uv run uvicorn aimdware_backend.main:app --host 127.0.0.1 --port 8000

# production-ish
uv run uvicorn aimdware_backend.main:app --host 0.0.0.0 --port 8000 --workers 4
```

**Put it behind TLS.** Students send their `student_token` in an
`Authorization` header, so terminate HTTPS at a reverse proxy
(nginx/Caddy) in front of uvicorn and give students the `https://…` URL
as their `backend_url`. Keep the app bound to localhost / private network
behind the proxy.

Sketch systemd unit:

```ini
[Service]
WorkingDirectory=/opt/aimdware/backend
EnvironmentFile=/etc/aimdware/backend.env
ExecStart=/usr/bin/uv run uvicorn aimdware_backend.main:app --host 127.0.0.1 --port 8000 --workers 4
Restart=on-failure
```

---

## 7. Verify it's up

```bash
# unauthenticated liveness
curl -s https://aimdware.example.edu/ingest/health        # → 200

# admin auth wired? (401 with a bad secret = enabled; 503 = secret unset)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer wrong' \
  https://aimdware.example.edu/admin/session/00000000-0000-0000-0000-000000000000/payload
```

---

## 8. Onboard the demo course + a student

`aimdware-admin` talks **directly to the DB**, so it needs
`AIMDWARE_DATABASE_URL` (and, for `record payload`, the `TBOX_*` vars).
v1 has **no in-CLI access control** — DB/shell access *is* the authority.

```bash
# course (matches the student guide's DEMO101 / demo1)
uv run aimdware-admin course create --code DEMO101 --title "Demo Course" --semester 2026-spring

# student
uv run aimdware-admin user create --jaccount alice --email alice@sjtu.edu.cn --name "Alice Liu"
uv run aimdware-admin enroll      --user alice --course DEMO101 --role student

# mint the token — THIS is the only time the plaintext is shown
uv run aimdware-admin token issue --user alice
#   → {"prefix":"st_K9aB6r","plaintext":"st_..."}   capture it, hand it to Alice
```

Give Alice four values for her `aimdware.yaml`: the **plaintext token**,
your `backend_url`, `course=DEMO101`, `assignment=demo1`.

> **Assignments need no setup.** `assignment` is a free-form course-scoped
> string checked by equality at ingest — `demo1` "exists" the moment a
> record arrives with it. Just agree on the slug
> (`A–Z a–z 0–9 _ . -`) with students.

> `--role admin` enrollment is reserved for future course-scoped
> authority; in v1 admin power comes from the shared secret + DB access,
> not from an `admin` enrollment.

---

## 9. Inspect captures (audit)

After Alice runs the demo (one model call through her router), records
appear. List them:

```bash
uv run aimdware-admin record list --course DEMO101 --assignment demo1
# add: --user alice  --status uploaded  --limit 20
```

Fetch + verify a blob (pulls from your Tbox, recomputes sha256):

```bash
# needs AIMDWARE_TBOX_URL/_USER/_PASS exported (step 5)
uv run aimdware-admin record payload --id <record_id> \
  | jq -r '.payload_utf8' | jq '.request.messages'
```

Or via the HTTP admin API (same logic, shared-secret auth). Prefer the
**session** endpoint for canonical verification — the on-jbox blob is
always the latest turn:

```bash
curl -s -H "Authorization: Bearer $AIMDWARE_ADMIN_SECRET" \
  https://aimdware.example.edu/admin/session/<session_id>/payload | jq .verified
```

**Multi-turn caveat:** a session's jbox file is **overwritten each
turn**, so only the latest turn's `blob_hash` matches what's on jbox. On
`/admin/context/<record_id>/payload`, the `is_latest_turn` flag tells you
whether a mismatch is tampering vs. just an older turn. Use the session
endpoint to verify "what's there now". `blob_status` values:
`pending → uploaded → verified | tampered | missing` (see
[backend.md](backend.md)).

---

## 10. Token rotation & revocation

```bash
uv run aimdware-admin token list  --user alice
uv run aimdware-admin token issue --user alice          # rotate: revokes old, prints new
uv run aimdware-admin token revoke --prefix st_K9aB6r   # kill a leaked token
```

At most one active token per student. If a student loses the plaintext,
`token issue` again is the only path (the backend stores only the hash).

---

## 11. Security & ops recap

- **No blobs on the backend.** A full DB compromise yields metadata +
  hashes + URIs, never student work — that lives on jbox accounts the
  backend can't decrypt.
- **DB stores only `sha256(token)`.** A leak exposes no usable token;
  respond by rotating (step 10).
- **`/admin/*` = shared secret.** Treat `AIMDWARE_ADMIN_SECRET` like a
  root password; rotate it by changing the env var and restarting.
- **A stolen student token is write-only** and scoped to that student's
  enrolled courses; it cannot read anyone's data.
- **Backups:** back up Postgres for the audit trail. Blobs are the
  students' (on jbox) — not your responsibility to retain.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/admin/*` returns 503 | `AIMDWARE_ADMIN_SECRET` unset | export it, restart |
| Ingest returns 403 | student not enrolled in `course_code` | `aimdware-admin enroll …` |
| Ingest returns 409 | replayed `record_id` w/ different body, or `(session_id,turn_count)` clash | usually benign (router retry); investigate if persistent |
| `record payload` can't fetch | `TBOX_*` unset / Tbox down / no read access to that folder | export creds, start Tbox, fix jbox sharing |
| `verified: false` with `is_latest_turn: false` | you verified an older turn | use `/admin/session/<id>/payload` |
| alembic can't connect | bad `AIMDWARE_DATABASE_URL` / driver | fix URL, install the driver |
| students' tokens all rejected | wrong `backend_url` or DB mismatch | confirm proxy → app, same DB the CLI uses |
