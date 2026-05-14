#!/usr/bin/env bash
# Show what the backend and jbox captured for $COURSE since bringup.
# Usage:  ./test-functional/inspect.sh [SESSION_ID]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${WORK:-}" ]; then
  WORK="$(ls -1dt "$REPO_ROOT"/test-functional/runs/* 2>/dev/null | head -1)"
fi
DB="$WORK/aimdware.db"
[ -f "$DB" ] || { echo "no aimdware.db at $DB"; exit 1; }

echo "=== context_records ==="
sqlite3 "$DB" -header -column <<SQL
SELECT substr(id,1,8) AS record,
       substr(session_id,1,8) AS session,
       turn_count,
       blob_status,
       blob_size,
       model
FROM context_records
ORDER BY ts;
SQL

# If a session_id was passed in, also fetch the jbox blob.
SID="${1:-}"
if [ -z "$SID" ]; then
  SID="$(sqlite3 "$DB" \
    "SELECT session_id FROM context_records ORDER BY ts DESC LIMIT 1;" 2>/dev/null)"
fi
SID_FMT="${SID:0:8}-${SID:8:4}-${SID:12:4}-${SID:16:4}-${SID:20:12}"
[ -n "$SID" ] && [ -n "${COURSE:-}" ] && {
  echo
  echo "=== /admin/session/$SID_FMT/payload ==="
  curl -sS -H "Authorization: Bearer ${AIMDWARE_ADMIN_SECRET:-func-admin-secret}" \
    "http://127.0.0.1:${BACKEND_PORT}/admin/session/$SID_FMT/payload" \
    | python3 -m json.tool 2>/dev/null \
    | head -40
}
