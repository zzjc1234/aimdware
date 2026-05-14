#!/usr/bin/env bash
# Source this file:  source ./test-functional/bringup.sh
# Exports BACKEND_PORT, ROUTER_PORT, COURSE, TOKEN, WORK so the caller
# can run opencode + ./test-functional/inspect.sh.
set -euo pipefail

# Works under bash (BASH_SOURCE) and zsh (where $0 is the sourced path
# during `source`). Falls back to $PWD if both are unset.
_self="${BASH_SOURCE[0]:-${(%):-%x}}"
_self="${_self:-$0}"
REPO_ROOT="$(cd "$(dirname "$_self")/.." && pwd)"
export WORK="$REPO_ROOT/test-functional/runs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"

# Tbox: already running locally (admin:admin @ 127.0.0.1:50471).
export AIMDWARE_TBOX_URL="${AIMDWARE_TBOX_URL:-http://127.0.0.1:50471}"
export AIMDWARE_TBOX_USER="${AIMDWARE_TBOX_USER:-admin}"
export AIMDWARE_TBOX_PASS="${AIMDWARE_TBOX_PASS:-admin}"

# Upstream: SJTU OpenAI-compatible gateway.
UPSTREAM_BASE="${SJTU_UPSTREAM_BASE:-https://models.sjtu.edu.cn/api/v1}"
UPSTREAM_KEY="${SJTU_UPSTREAM_KEY:?set SJTU_UPSTREAM_KEY env var first}"

export COURSE="FUNC-$(date +%s)"
export BACKEND_PORT="$((20000 + RANDOM % 30000))"
export ROUTER_PORT="$((20000 + RANDOM % 30000))"
export AIMDWARE_DATABASE_URL="sqlite:///$WORK/aimdware.db"
export AIMDWARE_ADMIN_SECRET="func-admin-secret"

echo "--- workdir: $WORK ---"
echo "  backend:   :$BACKEND_PORT"
echo "  router:    :$ROUTER_PORT"
echo "  course:    $COURSE"
echo "  upstream:  $UPSTREAM_BASE"
echo "  tbox:      $AIMDWARE_TBOX_URL"

# Probe Tbox.
if ! curl -sS -u "$AIMDWARE_TBOX_USER:$AIMDWARE_TBOX_PASS" -o /dev/null -w "%{http_code}\n" \
    "$AIMDWARE_TBOX_URL/" | grep -qE '^(200|207|401)$'; then
  echo "FAIL: Tbox at $AIMDWARE_TBOX_URL is not responding" >&2
  return 1 2>/dev/null || exit 1
fi

# Apply alembic migrations on the fresh DB.
(cd "$REPO_ROOT/backend" && uv run alembic upgrade head >"$WORK/alembic.log" 2>&1)

# Start backend.
(cd "$REPO_ROOT/backend" && \
  uv run uvicorn aimdware_backend.main:app --port "$BACKEND_PORT" --log-level warning \
  ) >"$WORK/backend.log" 2>&1 &
echo $! >"$WORK/backend.pid"

for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$BACKEND_PORT/ingest/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# Seed user + course + token.
export E2E_PLAINTEXT="st_FUNC_TEST_$(date +%s)"
TOKEN="$(cd "$REPO_ROOT/backend" && E2E_COURSE="$COURSE" \
  uv run python scripts/seed_for_e2e.py)"
export TOKEN
echo "--- token issued: ${TOKEN:0:8}… ---"

# Write router config.
cat >"$WORK/aimdware.yaml" <<EOF
student_token: $TOKEN
course: $COURSE
upstream:
  type: openai
  base_url: $UPSTREAM_BASE
  api_key: $UPSTREAM_KEY
port: $ROUTER_PORT
local_cache_dir: $WORK/cache
backend_url: http://127.0.0.1:$BACKEND_PORT
tbox_url: $AIMDWARE_TBOX_URL
tbox_user: $AIMDWARE_TBOX_USER
tbox_pass: $AIMDWARE_TBOX_PASS
EOF

# Start router.
(cd "$REPO_ROOT/llm-client" && bun run src/main.ts --config "$WORK/aimdware.yaml") \
  >"$WORK/router.log" 2>&1 &
echo $! >"$WORK/router.pid"

for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$ROUTER_PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# Project-local opencode.json so `opencode run` uses our router.
cat >"$REPO_ROOT/test-functional/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "aimdware": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "aimdware (via router)",
      "options": {
        "baseURL": "http://127.0.0.1:$ROUTER_PORT/v1",
        "apiKey": "ignored-router-uses-its-own-upstream-key"
      },
      "models": {
        "deepseek-chat":     { "name": "DeepSeek V3.2 chat" },
        "deepseek-reasoner": { "name": "DeepSeek V3.2 reasoner" },
        "minimax":           { "name": "MiniMax M2.7" },
        "glm":               { "name": "GLM 5.1" },
        "qwen":              { "name": "Qwen3.5 27B" }
      }
    }
  }
}
EOF
echo "--- opencode.json written; use:   opencode run --model aimdware/deepseek-chat \"...\" ---"

# Dump everything to env.sh so subsequent bash invocations can pick it
# up without re-sourcing bringup.sh.
cat >"$WORK/env.sh" <<EOF
export WORK="$WORK"
export BACKEND_PORT="$BACKEND_PORT"
export ROUTER_PORT="$ROUTER_PORT"
export COURSE="$COURSE"
export TOKEN="$TOKEN"
export AIMDWARE_DATABASE_URL="$AIMDWARE_DATABASE_URL"
export AIMDWARE_ADMIN_SECRET="$AIMDWARE_ADMIN_SECRET"
export AIMDWARE_TBOX_URL="$AIMDWARE_TBOX_URL"
export AIMDWARE_TBOX_USER="$AIMDWARE_TBOX_USER"
export AIMDWARE_TBOX_PASS="$AIMDWARE_TBOX_PASS"
EOF
ln -snf "$WORK" "$REPO_ROOT/test-functional/.current"
echo "--- workdir saved as \$WORK = $WORK ---"
echo "--- subsequent shells:  source test-functional/.current/env.sh ---"
