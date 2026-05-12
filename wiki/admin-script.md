# Admin script

The TT-side command-line tool. Talks directly to the backend's Postgres
(via the same SQLModel schema) for user / course / token management,
and pulls blobs from jbox for inspection via a locally-running Tbox
WebDAV endpoint bound to the TT's own jaccount.

The caller's authority is scoped to the courses where they hold
`role = admin` in `enrollments`. All commands filter by that scope; an
admin in CS101 cannot list / fetch records or issue tokens for CS201.
Identity is read from `$AIMDWARE_ADMIN_JACCOUNT` (or a `--as <jaccount>`
flag). This is soft enforcement — raw SQL bypasses it.

## Tech stack

- Python 3.12, same SQLModel schema as the backend
- Shipped as a Python package in the same repo
- jbox access: TT runs [Tbox](https://github.com/1357310795/TboxWebdav)
  locally (same as the student-side setup, just authenticated to the
  TT's jaccount). `records fetch` shells out to `rclone` against the
  Tbox WebDAV endpoint — e.g. `rclone copy tbox:<student>/aimdware/<course>/<record_id>.json ./`.
  Student-side permission grants on those paths are handled out-of-band.

## Commands

```
aimdware-admin user create   --jaccount zhangsan --email z@sjtu.edu.cn --display "Zhang San"
aimdware-admin course create --code ECE4721J --title "Intro to Systems" --semester 2026-spring
aimdware-admin enrol         --course ECE4721J --user zhangsan --role student   # or --role admin
aimdware-admin enrol-bulk    --course ECE4721J --csv roster.csv
aimdware-admin token issue   --user zhangsan       # one token per student; not course-scoped
aimdware-admin token revoke  --user zhangsan
aimdware-admin token rotate  --user zhangsan       # atomic revoke + issue
aimdware-admin records list  --course ECE4721J [--student zhangsan] [--since 2026-04-01]
aimdware-admin records show  --id <record_id>
aimdware-admin records fetch --id <record_id> [--verify]
```

- `records fetch` is the only command that touches jbox. Uses the TT's
  own jaccount; the backend never holds a jbox credential in v1.
- `--verify` recomputes sha256 over the fetched blob and writes
  `blob_status = verified | tampered | missing` back to the row.

## Token lifecycle

The plaintext token only exists at issue time. Backend stores
`sha256(plaintext)`; the student's router config is the only place the
plaintext lives long-term.

```
issue:
  plaintext = "st_" + crypto.randomBytes(32).base64url
  hash      = sha256(plaintext)
  prefix    = plaintext[:8]              # human ID, e.g. "st_K9aB"

  with atomic transaction:
    revoke any existing active token for this user
    INSERT INTO student_tokens (user_id, token_hash, prefix, created_at)
                         VALUES (uid, hash, prefix, now)

  print(plaintext)                       # only time plaintext is observable
                                         # ↳ hand to student through any channel

revoke:
  UPDATE student_tokens SET revoked_at = NOW()
  WHERE user_id = uid AND revoked_at IS NULL

rotate:
  atomic { revoke; issue }
  print new plaintext; student updates router config
```

`token issue` and `token rotate` print the plaintext exactly once and
nowhere else. If the student loses it, only `rotate` recovers (we
cannot read the old one back).

## Project layout

```
src/aimdware_admin/
  cli.py
  jbox_inspect.py
```
