# Admin script

`aimdware-admin` — the TT-side CLI. Talks directly to the backend's
database (same SQLModel schema) for user / course / token management,
and pulls blobs from jbox via a locally-running Tbox WebDAV endpoint
(bound to the TT's own jaccount) for inspection.

The CLI ships inside the `aimdware-backend` Python package and is
exposed as a `project.scripts` entry point, so it's installed alongside
the backend itself:

```bash
AIMDWARE_DATABASE_URL=postgresql://... \
    uv run aimdware-admin <subcommand> ...
```

v1 has **no in-CLI access control** — anyone who can run the script
can do anything. Authority is enforced by who has DB / shell access on
the backend host. Course-scoped admin role enforcement is deferred.

## Commands

```
aimdware-admin user create   --jaccount alice --email a@sjtu.edu.cn --name "Alice Liu"
aimdware-admin user list

aimdware-admin course create --code ECE4721J --title "Intro to Systems" --semester 2026-spring
aimdware-admin course list

aimdware-admin enroll        --user alice --course ECE4721J [--role student|admin]

aimdware-admin token issue   --user alice          # revokes any prior active token + issues new
aimdware-admin token revoke  --prefix st_K9aB6r    # 8-char prefix is shown when issued
aimdware-admin token list    [--user alice]

aimdware-admin record list   [--course X] [--user X] [--status pending|uploaded|...] [--limit N]
aimdware-admin record payload --id <record_id>     # fetch blob from Tbox + verify sha256
```

All commands print JSON to stdout (newline-indented) so scripts can
pipe through `jq`. `token issue` is the **only place the plaintext is
ever observable** — capture it immediately and hand it to the student
through your channel of choice.

## Token lifecycle

Backend stores `sha256(plaintext)`; the student's router config is the
only place the plaintext lives long-term.

```
issue:
  plaintext = "st_" + secrets.token_urlsafe(32)
  hash      = sha256(plaintext)
  prefix    = plaintext[:8]              # human ID, e.g. "st_K9aB6r"

  transaction:
    set revoked_at on any active token for this user
    INSERT INTO student_tokens (user_id, token_hash, prefix, created_at)
                         VALUES (uid, hash, prefix, now)

  print(plaintext)                       # ONLY time plaintext is observable

revoke:
  UPDATE student_tokens SET revoked_at = NOW()
  WHERE prefix = ? AND revoked_at IS NULL

rotate (= issue again):
  atomic { revoke active; insert new }
  print new plaintext
```

If the student loses the plaintext, `token issue` again is the only
path — we cannot recover the old one.

## record payload

`aimdware-admin record payload --id <uuid>` is the same logic as the
admin HTTP endpoint `GET /admin/context/<id>/payload`: it pulls the
blob from the configured Tbox endpoint (`AIMDWARE_TBOX_URL`,
`AIMDWARE_TBOX_USER`, `AIMDWARE_TBOX_PASS` env vars) and recomputes
sha256 against the stored `blob_hash`. Returns a `verified` flag plus
the UTF-8-decoded payload so the TT can `jq '.request.messages'` it
directly.

The CLI does **not** write `blob_status = verified | tampered | missing`
back to the DB. That's an operator-driven action and we want it in a
separate command (TODO).

## Deferred

- Course-scoped admin authority (filter commands by `--as <admin>`)
- `enroll bulk --csv roster.csv`
- `record verify` that updates `blob_status` after fetching
- Audit log of who ran which command when
