#!/usr/bin/env bash
# Kill backend + router, optionally clean Tbox course subdir.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${WORK:-}" ]; then
  echo "WORK env not set — pick the latest one"
  WORK="$(ls -1dt "$REPO_ROOT"/test-functional/runs/* 2>/dev/null | head -1)"
  [ -n "$WORK" ] || { echo "no runs/ found"; exit 1; }
  echo "  using $WORK"
fi

for pidf in "$WORK"/backend.pid "$WORK"/router.pid; do
  [ -f "$pidf" ] || continue
  PID="$(cat "$pidf")"
  kill "$PID" 2>/dev/null || true
done

# Best-effort Tbox cleanup for the course folder, unless KEEP=1.
if [ -z "${KEEP:-}" ] && [ -n "${COURSE:-}" ]; then
  TBOX_URL="${AIMDWARE_TBOX_URL:-http://127.0.0.1:50471}"
  TBOX_USER="${AIMDWARE_TBOX_USER:-admin}"
  TBOX_PASS="${AIMDWARE_TBOX_PASS:-admin}"
  curl -sS -u "$TBOX_USER:$TBOX_PASS" -X DELETE \
    "$TBOX_URL/aimdware/$COURSE" >/dev/null 2>&1 || true
  echo "Tbox: deleted /aimdware/$COURSE"
fi

echo "torn down (workdir kept at $WORK)"
