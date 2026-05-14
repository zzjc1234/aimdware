# Test 4 — agent calls an MCP tool

## Goal
Verify the router captures **tool_calls + tool messages** that come
from an MCP-backed tool. Same session-merging property as test 3: many
HTTP turns, one jbox blob.

## Setup

Use a minimal local MCP server — the official `@modelcontextprotocol/server-filesystem`
serving a single read-only temp dir we seed with one known file. opencode's
project-local config wires it in.

```
test-functional/mcp-sandbox/HELLO.txt   ← single seed file
```

opencode config snippet (added to test-functional/opencode.json by setup):
```jsonc
"mcp": {
  "fs": {
    "type": "local",
    "command": ["bunx", "-y", "@modelcontextprotocol/server-filesystem", "<absolute path to mcp-sandbox>"]
  }
}
```

## Prompt verbatim

```
There is a single file inside the MCP `fs` server's sandbox.
Use the filesystem MCP tools to read it and tell me its contents,
verbatim. Don't paraphrase.
```

## Model

`aimdware/deepseek-chat`

## How to run

```bash
source ./test-functional/bringup.sh
mkdir -p test-functional/mcp-sandbox
echo "hello from MCP land" > test-functional/mcp-sandbox/HELLO.txt
cd test-functional
opencode run --model aimdware/deepseek-chat \
  "There is a single file inside the MCP fs server's sandbox. Use the filesystem MCP tools to read it and tell me its contents, verbatim. Don't paraphrase."
cd ..
sleep 12          # tool round-trips eat time
./test-functional/inspect.sh
```

## Expected

- Backend: ≥3 records, all sharing one session_id (typical: list →
  read → respond).
- jbox blob's `messages` array contains:
  - `role: assistant` turn with `tool_calls`
  - `role: tool` turn with the file contents
  - final `role: assistant` reply
- `verified=true`.

## What to flag

- If the tool round-trips are split across **different** session_ids,
  the SessionTracker prefix check broke. This would mean some tool
  framework is mutating earlier messages between turns rather than
  appending.
