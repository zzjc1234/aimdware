#!/usr/bin/env bash
# Multi-turn agent smoke against the REAL Tbox. Proves Design A:
#   - 3 turns of the same growing conversation produce 3 records
#     but ONE blob file on jbox (session-keyed, overwritten each turn).
#   - /admin/session/<id>/payload returns verified=true against the
#     latest turn's hash.
#
# Env (optional):
#   AIMDWARE_TBOX_URL   (default http://127.0.0.1:50471)
#   AIMDWARE_TBOX_USER  (default admin)
#   AIMDWARE_TBOX_PASS  (default admin)
#   KEEP_TBOX_DATA=1    keep the per-run Tbox subdir + local cache
#
# Run from repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d -t aimdware-agent-smoke-XXXX)"

TBOX_URL="${AIMDWARE_TBOX_URL:-http://127.0.0.1:50471}"
TBOX_USER="${AIMDWARE_TBOX_USER:-admin}"
TBOX_PASS="${AIMDWARE_TBOX_PASS:-admin}"

STAMP="$(date +%s)-$$"
COURSE="AGENT${STAMP}"
TBOX_SUBDIR="aimdware/$COURSE"
ADMIN_SECRET="agent-admin-secret-$STAMP"

DB_FILE="$WORK/aimdware.db"
CACHE_DIR="$WORK/cache"
BACKEND_PORT="$((20000 + RANDOM % 30000))"
ROUTER_PORT="$((20000 + RANDOM % 30000))"
UPSTREAM_PORT="$((20000 + RANDOM % 30000))"

cleanup() {
  echo "--- cleanup ---"
  jobs -p | xargs -r kill 2>/dev/null || true
  if [ -n "${KEEP_TBOX_DATA:-}" ]; then
    echo "  KEEP_TBOX_DATA=1 — leaving $TBOX_SUBDIR on Tbox"
    echo "  inspect:  curl -u $TBOX_USER:$TBOX_PASS $TBOX_URL/$TBOX_SUBDIR/"
  else
    curl -sS -u "$TBOX_USER:$TBOX_PASS" -X DELETE "$TBOX_URL/$TBOX_SUBDIR" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

echo "--- workdir: $WORK ---"
echo "  course:   $COURSE"

# Probe Tbox.
if ! curl -sS -u "$TBOX_USER:$TBOX_PASS" -o /dev/null -w "%{http_code}\n" \
    "$TBOX_URL/" | grep -qE '^(200|207|401)$'; then
  echo "FAIL: Tbox at $TBOX_URL is not responding"; exit 1
fi

# Backend.
export AIMDWARE_DATABASE_URL="sqlite:///$DB_FILE"
export AIMDWARE_TBOX_URL="$TBOX_URL"
export AIMDWARE_TBOX_USER="$TBOX_USER"
export AIMDWARE_TBOX_PASS="$TBOX_PASS"
export AIMDWARE_ADMIN_SECRET="$ADMIN_SECRET"
(cd "$REPO_ROOT/backend" && uv run uvicorn aimdware_backend.main:app --port "$BACKEND_PORT" --log-level warning) >"$WORK/backend.log" 2>&1 &

# Fake upstream — echoes the turn number.
bun -e "
let turn = 0;
Bun.serve({ port: $UPSTREAM_PORT, hostname: '127.0.0.1', async fetch() {
  turn++;
  return new Response(JSON.stringify({
    id: 'turn-' + turn,
    choices: [{ message: { role: 'assistant', content: 'reply #' + turn } }]
  }), { headers: { 'content-type': 'application/json' } });
}});" >"$WORK/upstream.log" 2>&1 &

for i in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$BACKEND_PORT/ingest/health" >/dev/null 2>&1 && break
  sleep 0.2
done

# Seed user + course + token.
export E2E_PLAINTEXT="st_AGENT_SMOKE_TOKEN_xxxxxxxxxxxx"
TOKEN="$(cd "$REPO_ROOT/backend" && E2E_COURSE="$COURSE" \
  AIMDWARE_DATABASE_URL="$AIMDWARE_DATABASE_URL" uv run python scripts/seed_for_e2e.py)"

# Router config.
cat >"$WORK/aimdware.yaml" <<EOF
student_token: $TOKEN
course: $COURSE
upstream:
  base_url: http://127.0.0.1:$UPSTREAM_PORT
  api_key: sk-agent-smoke
port: $ROUTER_PORT
local_cache_dir: $CACHE_DIR
backend_url: http://127.0.0.1:$BACKEND_PORT
tbox_url: $TBOX_URL
tbox_user: $TBOX_USER
tbox_pass: $TBOX_PASS
EOF
(cd "$REPO_ROOT/llm-client" && bun run src/main.ts --config "$WORK/aimdware.yaml") >"$WORK/router.log" 2>&1 &

for i in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$ROUTER_PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done

# Three "agent" turns — each turn re-sends the full history.
MSGS='[{"role":"user","content":"start a todo app"}]'
for turn in 1 2 3; do
  REQ=$(jq -nc --argjson m "$MSGS" '{model:"gpt-4o",messages:$m}')
  RESP=$(curl -sS -X POST "http://127.0.0.1:$ROUTER_PORT/v1/chat/completions" \
    -H 'content-type: application/json' -d "$REQ")
  ASSISTANT=$(echo "$RESP" | jq -r '.choices[0].message.content')
  echo "turn $turn  sent=$(echo "$MSGS" | jq 'length') msgs  got: $ASSISTANT"
  MSGS=$(echo "$MSGS" | jq -c --arg a "$ASSISTANT" --arg next "next step for turn $((turn+1))?" \
    '. + [{role:"assistant",content:$a},{role:"user",content:$next}]')
done

sleep 8

# Backend DB: 3 records, all sharing one session_id, turn_count 1/2/3
echo
echo "--- backend records (all should share session_id) ---"
sqlite3 "$DB_FILE" -header -column \
  "SELECT substr(id,1,8) AS record, session_id, turn_count, blob_status, blob_size FROM context_records ORDER BY turn_count;"

DISTINCT=$(sqlite3 "$DB_FILE" "SELECT COUNT(DISTINCT session_id) FROM context_records;")
TOTAL=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM context_records;")
[ "$DISTINCT" = "1" ] || { echo "FAIL: expected 1 distinct session, got $DISTINCT"; exit 1; }
[ "$TOTAL"    = "3" ] || { echo "FAIL: expected 3 records, got $TOTAL"; exit 1; }
echo "OK: $TOTAL records / $DISTINCT session"

# jbox: exactly ONE blob file under /aimdware/$COURSE/
echo
echo "--- jbox listing (should be ONE file, not three) ---"
COUNT=$(curl -s -u "$TBOX_USER:$TBOX_PASS" -X PROPFIND -H "Depth: 1" "$TBOX_URL/$TBOX_SUBDIR/" \
  | grep -oE '<D:href>[^<]+\.json</D:href>' | wc -l | tr -d ' ')
echo "  json files on jbox under /$TBOX_SUBDIR/: $COUNT"
[ "$COUNT" = "1" ] || { echo "FAIL: expected exactly 1 blob, got $COUNT"; exit 1; }

# Session-level verify endpoint
SESSION_ID=$(sqlite3 "$DB_FILE" "SELECT session_id FROM context_records LIMIT 1;")
SESSION_ID_FMT="${SESSION_ID:0:8}-${SESSION_ID:8:4}-${SESSION_ID:12:4}-${SESSION_ID:16:4}-${SESSION_ID:20:12}"

echo
echo "--- /admin/session/$SESSION_ID_FMT/payload ---"
RESP=$(curl -sS -H "Authorization: Bearer $ADMIN_SECRET" \
  "http://127.0.0.1:$BACKEND_PORT/admin/session/$SESSION_ID_FMT/payload")
echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"  session_id     {d['session_id']}\")
print(f\"  turn_count     {d['turn_count']}\")
print(f\"  blob_size      {d['blob_size_actual']}\")
print(f\"  verified       {d['verified']}\")
payload = json.loads(d['payload_utf8'])
print(f\"  blob has {len(payload['request']['messages'])} messages in final state\")
print(f\"  blob's turn_count field: {payload['turn_count']}\")
"
VERIFIED=$(echo "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["verified"])')
[ "$VERIFIED" = "True" ] || { echo "FAIL: session payload not verified"; exit 1; }

echo
echo "--- PASS: 3 turns -> 1 jbox file -> verified ---"
