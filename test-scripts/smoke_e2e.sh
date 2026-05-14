#!/usr/bin/env bash
# E2E smoke: real backend + router + fake upstream + fake WebDAV.
# Verifies a chat request lands as a ContextRecord in the backend DB
# with blob_status=uploaded.
#
# Run from the repo root:  ./test-scripts/smoke_e2e.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d -t aimdware-e2e-XXXX)"
trap 'echo "--- cleanup ---"; jobs -p | xargs -r kill 2>/dev/null; rm -rf "$WORK"' EXIT

DB_FILE="$WORK/aimdware.db"
CACHE_DIR="$WORK/cache"
BACKEND_PORT="$((20000 + RANDOM % 30000))"
ROUTER_PORT="$((20000 + RANDOM % 30000))"
UPSTREAM_PORT="$((20000 + RANDOM % 30000))"
TBOX_PORT="$((20000 + RANDOM % 30000))"

echo "--- workdir: $WORK ---"
echo "  db:       $DB_FILE"
echo "  backend:  :$BACKEND_PORT"
echo "  router:   :$ROUTER_PORT"
echo "  upstream: :$UPSTREAM_PORT"
echo "  tbox:     :$TBOX_PORT"

# 1. backend (real, sqlite-on-disk)
export AIMDWARE_DATABASE_URL="sqlite:///$DB_FILE"
(
  cd "$REPO_ROOT/backend"
  uv run uvicorn aimdware_backend.main:app --port "$BACKEND_PORT" --log-level warning
) >"$WORK/backend.log" 2>&1 &

# 2. fake upstream LLM
bun -e "
Bun.serve({
  port: $UPSTREAM_PORT, hostname: '127.0.0.1',
  fetch: () => new Response('{\"id\":\"smoke-upstream\",\"choices\":[{\"message\":{\"content\":\"OK\"}}]}', {
    status: 200, headers: { 'content-type': 'application/json' }
  })
});
" >"$WORK/upstream.log" 2>&1 &

# 3. fake Tbox (WebDAV PUT acceptor — handles MKCOL too since the router
# now calls createDirectory(parent, {recursive: true}) before each PUT).
bun -e "
Bun.serve({
  port: $TBOX_PORT, hostname: '127.0.0.1',
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === 'PUT') {
      const body = await req.arrayBuffer();
      console.log('PUT', u.pathname, body.byteLength);
      return new Response('', { status: 201 });
    }
    if (req.method === 'MKCOL') {
      console.log('MKCOL', u.pathname);
      return new Response('', { status: 201 });
    }
    if (req.method === 'PROPFIND') {
      // recursive MKCOL probes existence first; pretend nothing exists
      // so it always proceeds to create.
      return new Response('', { status: 404 });
    }
    return new Response('', { status: 200, headers: { DAV: '1,2' } });
  }
});
" >"$WORK/tbox.log" 2>&1 &

# wait for backend
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$BACKEND_PORT/ingest/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# 4. seed user / course / enrollment / token
export E2E_PLAINTEXT="st_E2E_SMOKE_TEST_TOKEN_xxxxxxxxxxxx"
TOKEN="$(
  cd "$REPO_ROOT/backend"
  AIMDWARE_DATABASE_URL="$AIMDWARE_DATABASE_URL" \
  uv run python scripts/seed_for_e2e.py
)"
echo "--- seeded token: ${TOKEN:0:8}… ---"

# 5. router config
cat >"$WORK/aimdware.yaml" <<EOF
student_token: $TOKEN
course: ECE4721J
assignment: smoke
upstream:
  base_url: http://127.0.0.1:$UPSTREAM_PORT
  api_key: sk-smoke-test-key
port: $ROUTER_PORT
local_cache_dir: $CACHE_DIR
backend_url: http://127.0.0.1:$BACKEND_PORT
tbox_url: http://127.0.0.1:$TBOX_PORT
EOF

# 6. router
(
  cd "$REPO_ROOT/llm-client"
  bun run src/main.ts --config "$WORK/aimdware.yaml"
) >"$WORK/router.log" 2>&1 &

# wait for router
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$ROUTER_PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# 7. fire a chat completion
echo "--- chat ---"
curl -sS -X POST "http://127.0.0.1:$ROUTER_PORT/v1/chat/completions" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"smoke"}]}'
echo

# 8. wait for ingest -> sync -> confirm (3 stages × ~1s worker poll)
sleep 8

# 9. inspect db
echo "--- ContextRecord rows ---"
sqlite3 "$DB_FILE" "SELECT id, model, blob_size, blob_status FROM context_records;"

# 10. confirm at least one record with status=uploaded
COUNT="$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM context_records WHERE blob_status = 'uploaded';")"
if [ "$COUNT" -ge 1 ]; then
  echo "--- PASS: $COUNT record(s) with blob_status=uploaded ---"
else
  echo "--- FAIL: 0 records with blob_status=uploaded ---"
  echo "--- router log tail ---"
  tail -20 "$WORK/router.log"
  echo "--- backend log tail ---"
  tail -20 "$WORK/backend.log"
  exit 1
fi
