#!/usr/bin/env bash
# E2E smoke with the REAL Tbox WebDAV server.
#
# Flow:
#   1. start backend (real, sqlite on disk) wired to real Tbox creds
#   2. start a fake upstream LLM (we don't want to depend on a real provider)
#   3. seed user + UNIQUE course + token in backend
#   4. start router with config pointing at real Tbox + admin auth
#   5. fire a chat completion through the router
#   6. assert: a ContextRecord exists with blob_status=uploaded
#   7. assert: /admin/context/{id}/payload reads back from Tbox AND hash verifies
#   8. cleanup: DELETE the course-scoped subdir from Tbox
#
# Configurable via env:
#   AIMDWARE_TBOX_URL   (default http://127.0.0.1:50471)
#   AIMDWARE_TBOX_USER  (default admin)
#   AIMDWARE_TBOX_PASS  (default admin)
#
# Run from the repo root:  ./test-scripts/smoke_e2e_real_tbox.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d -t aimdware-e2e-real-XXXX)"

TBOX_URL="${AIMDWARE_TBOX_URL:-http://127.0.0.1:50471}"
TBOX_USER="${AIMDWARE_TBOX_USER:-admin}"
TBOX_PASS="${AIMDWARE_TBOX_PASS:-admin}"

# Unique per-run course so each smoke run gets its own Tbox subdir.
STAMP="$(date +%s)-$$"
COURSE="SMOKE${STAMP}"
TBOX_SUBDIR="aimdware/$COURSE"
ADMIN_SECRET="smoke-admin-secret-$STAMP"

DB_FILE="$WORK/aimdware.db"
CACHE_DIR="$WORK/cache"
BACKEND_PORT="$((20000 + RANDOM % 30000))"
ROUTER_PORT="$((20000 + RANDOM % 30000))"
UPSTREAM_PORT="$((20000 + RANDOM % 30000))"

cleanup() {
  echo "--- cleanup ---"
  jobs -p | xargs -r kill 2>/dev/null || true
  if [ -n "${KEEP_TBOX_DATA:-}" ]; then
    echo "  KEEP_TBOX_DATA=1 — leaving $TBOX_SUBDIR on Tbox and $WORK on disk"
    echo "  inspect:  curl -u $TBOX_USER:$TBOX_PASS $TBOX_URL/$TBOX_SUBDIR/"
  else
    curl -sS -u "$TBOX_USER:$TBOX_PASS" -X DELETE "$TBOX_URL/$TBOX_SUBDIR" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

echo "--- workdir: $WORK ---"
echo "  db:       $DB_FILE"
echo "  backend:  :$BACKEND_PORT"
echo "  router:   :$ROUTER_PORT"
echo "  upstream: :$UPSTREAM_PORT"
echo "  tbox:     $TBOX_URL (real, user=$TBOX_USER)"
echo "  course:   $COURSE"

# 0. Probe Tbox before anything else.
if ! curl -sS -u "$TBOX_USER:$TBOX_PASS" -o /dev/null -w "%{http_code}\n" \
    "$TBOX_URL/" | grep -qE '^(200|207|401)$'; then
  echo "FAIL: Tbox at $TBOX_URL is not responding"
  exit 1
fi

# 1. backend wired to real Tbox creds + admin secret
export AIMDWARE_DATABASE_URL="sqlite:///$DB_FILE"
export AIMDWARE_TBOX_URL="$TBOX_URL"
export AIMDWARE_TBOX_USER="$TBOX_USER"
export AIMDWARE_TBOX_PASS="$TBOX_PASS"
export AIMDWARE_ADMIN_SECRET="$ADMIN_SECRET"
(
  cd "$REPO_ROOT/backend"
  uv run uvicorn aimdware_backend.main:app --port "$BACKEND_PORT" --log-level warning
) >"$WORK/backend.log" 2>&1 &

# 2. fake upstream
bun -e "
Bun.serve({
  port: $UPSTREAM_PORT, hostname: '127.0.0.1',
  fetch: () => new Response(JSON.stringify({
    id: 'smoke-real-tbox',
    choices: [{ message: { content: 'OK from real-tbox smoke' } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } })
});
" >"$WORK/upstream.log" 2>&1 &

# wait for backend
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$BACKEND_PORT/ingest/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# 3. seed user/course/enrollment/token (custom course!)
export E2E_PLAINTEXT="st_E2E_REAL_TBOX_TOKEN_xxxxxxxxxxxx"
TOKEN="$(
  cd "$REPO_ROOT/backend"
  E2E_COURSE="$COURSE" \
  AIMDWARE_DATABASE_URL="$AIMDWARE_DATABASE_URL" \
  uv run python scripts/seed_for_e2e.py
)"
echo "--- seeded token: ${TOKEN:0:8}… course: $COURSE ---"

# 4. router config -> real Tbox with creds
cat >"$WORK/aimdware.yaml" <<EOF
student_token: $TOKEN
course: $COURSE
assignment: smoke
upstream:
  base_url: http://127.0.0.1:$UPSTREAM_PORT
  api_key: sk-smoke-test-key
port: $ROUTER_PORT
local_cache_dir: $CACHE_DIR
backend_url: http://127.0.0.1:$BACKEND_PORT
tbox_url: $TBOX_URL
tbox_user: $TBOX_USER
tbox_pass: $TBOX_PASS
EOF

# 5. router
(
  cd "$REPO_ROOT/llm-client"
  bun run src/main.ts --config "$WORK/aimdware.yaml"
) >"$WORK/router.log" 2>&1 &

for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$ROUTER_PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# 6. fire a chat
echo "--- chat ---"
curl -sS -X POST "http://127.0.0.1:$ROUTER_PORT/v1/chat/completions" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello real tbox"}]}'
echo

# 7. wait for ingest -> sync -> confirm
sleep 8

# 8. inspect db
echo "--- ContextRecord rows (backend) ---"
sqlite3 "$DB_FILE" "SELECT id, model, blob_size, blob_status, hex(blob_hash) FROM context_records;"

echo "--- outbox rows (router) ---"
sqlite3 "$CACHE_DIR/queue.db" "SELECT record_id, state, attempts, last_error FROM outbox;" || true

COUNT="$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM context_records WHERE blob_status = 'uploaded';")"
if [ "$COUNT" -lt 1 ]; then
  echo "FAIL: 0 records reached blob_status=uploaded"
  echo "--- router log tail ---"; tail -25 "$WORK/router.log"
  echo "--- backend log tail ---"; tail -25 "$WORK/backend.log"
  exit 1
fi
echo "--- $COUNT record(s) marked uploaded ---"

# 9. round-trip verify via /admin/context/{id}/payload — proves the blob
#    actually landed in Tbox and the stored hash matches what's there.
# SQLAlchemy stores UUID as a 32-char string in sqlite — read directly,
# then format with hyphens for the URL.
RAW_ID="$(sqlite3 "$DB_FILE" "SELECT id FROM context_records LIMIT 1;")"
ID="${RAW_ID:0:8}-${RAW_ID:8:4}-${RAW_ID:12:4}-${RAW_ID:16:4}-${RAW_ID:20:12}"
echo "--- verify payload via /admin/context/$ID/payload ---"

RESP="$(curl -sS -H "Authorization: Bearer $ADMIN_SECRET" \
  "http://127.0.0.1:$BACKEND_PORT/admin/context/$ID/payload")"
echo "$RESP" | head -c 400; echo "…"

VERIFIED="$(echo "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["verified"])')"
if [ "$VERIFIED" != "True" ]; then
  echo "FAIL: payload hash did NOT verify"
  echo "$RESP"
  exit 1
fi
echo "--- PASS: payload verified end-to-end against real Tbox ---"
