# aimdware-admin CSV batch — design

## Goal
Let TT manage a whole roster in one shot. `user create`, `enroll`, `token issue`,
`token revoke` each gain a `--csv` mode that operates over a roster file, while
keeping their existing single-item forms.

## Roster CSV
- UTF-8 (BOM tolerated), column order `name,student_id,jaccount` (Chinese
  header `名字,学号,jaccount` allowed).
- A header row is auto-detected and skipped; blank lines skipped.
- Per row only `jaccount` is required; `student_id` may be empty. `name` is
  required for `user create` (the others ignore it).

## Data model
- `User` gains `student_id: str | None = None` — nullable, **not unique**
  (rosters may carry blanks/dupes; we don't want import to fail on it).
- `email` is now derivable: when not supplied, use `<jaccount>@<domain>`,
  default domain `sjtu.edu.cn`, overridable with `--email-domain`.
- Alembic migration `0004_add_student_id`: add nullable `users.student_id`.

## Commands (single-item form preserved; `--csv` is mutually exclusive with it)
| Command | CSV form | Per-row behavior |
|---|---|---|
| `user create` | `--csv FILE [--email-domain D]` | create user (display_name=name, student_id, email derived); existing jaccount → `exists` |
| `enroll` | `--csv FILE --course C [--role student]` | enroll jaccount in C; already enrolled → `exists` |
| `token issue` | `--csv FILE` | issue (rotates) per jaccount; result carries `plaintext`+`prefix` |
| `token revoke` | `--csv FILE` | revoke ALL active tokens for that jaccount; result carries revoked count |

Single forms: `user create` gains optional `--email` (derived if omitted) and
`--student-id`; `token revoke --prefix` is unchanged.

## Batch semantics
- Process rows independently, **continue on error**.
- Print a JSON array of `{jaccount, status, ...}` (status ∈
  created/exists/enrolled/issued/revoked/error; error rows carry `error`).
- Exit non-zero if any row errored (so scripts can detect partial failure).

## Internal structure
Extract the core of each operation into a function taking a `Session`
(`create_user`, `enroll_user`, `issue_token` already exists, `revoke_tokens_for_user`).
Single and CSV paths both call these — no duplicated logic. Roster parsing lives
in `roster.py` (`read_roster(path) -> list[RosterRow]`) so it is unit-testable.

## Tests (TDD)
- `roster.read_roster`: 3-col UTF-8 parse, header/blank skip, jaccount required.
- `user create --csv`: derived email + stored student_id; existing jaccount → exists, no crash.
- `user create` single: email derived when omitted; `--student-id` stored.
- `enroll --csv`: enroll all; already-enrolled → exists.
- `token issue --csv`: per-jaccount issue, output has plaintext+prefix, rotates.
- `token revoke --csv`: revokes all active per user; count.
- model: `student_id` defaults None / nullable.

## Docs
Update `wiki/ta-deployment.md` and `wiki/admin-script.md` with the `--csv` forms.

## Out of scope
- `enrollment list --course` (separate ask).
- Unique constraint / validation on student_id.
- Writing tokens to a CSV file directly (JSON array output is enough; TT can format).
