# Functional tests against real SJTU upstream

End-to-end functional tests that drive the aimdware router with **real**
LLM calls through the SJTU OpenAI-compatible gateway, then inspect what
landed in the backend DB + jbox.

## Stack

```
opencode → 127.0.0.1:$ROUTER_PORT/v1   (aimdware-router)
              ↓ records to outbox
              ↓ blob → real Tbox (admin:admin @ 127.0.0.1:50471)
              ↓ metadata → backend (on-disk sqlite under runs/)
            real upstream: https://models.sjtu.edu.cn/api/v1
```

Constraints:
- 10 req/min, 100k tok/min, 1B tok/week.
- Pace tests serially; don't run two at once.

## Models

| name in config           | call name         |
|--------------------------|-------------------|
| DeepSeek V3.2 (chat)     | `deepseek-chat`   |
| DeepSeek V3.2 (reason)   | `deepseek-reasoner` |
| MiniMax-M2.7             | `minimax`         |
| GLM-5.1                  | `glm`             |
| Qwen3.5-27B              | `qwen`            |

## Layout

```
test-functional/
  bringup.sh       starts backend + router, exports BACKEND_PORT / ROUTER_PORT
  teardown.sh      kills bg + best-effort Tbox cleanup
  opencode.json    project-local opencode config: provider → router
  prompts/         one prompt file per test (verbatim copy of what we send)
  runs/            per-test artifacts: backend db, router log, captured blob hash
                   (gitignored)
```

## Running a test

```
source ./test-functional/bringup.sh        # exports envs
cat   ./test-functional/prompts/01-small-task.md   # see the prompt
opencode run --model aimdware/deepseek-chat "..."  # invoke
./test-functional/inspect.sh               # dump DB + jbox blob
./test-functional/teardown.sh
```

## What each test exercises

| # | Prompt file                  | Tests |
|---|-------------------------------|-------|
| 1 | `01-small-task.md`            | Single-turn capture; session of 1 |
| 2 | `02-multimodal.md`            | Vision request; what the blob captures |
| 3 | `03-skill.md`                 | Skill invocation; tool-message turns in blob |
| 4 | `04-mcp.md`                   | MCP tool call; tool-result turns |
| 5 | `05-compression.md`           | Long session; opencode compression behavior vs SessionTracker prefix detection |
