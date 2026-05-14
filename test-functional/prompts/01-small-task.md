# Test 1 — agent executes a small task

## Goal
Single-turn capture: prove that one chat-completion through the router
lands as exactly **one ContextRecord (turn_count=1)** in the backend and
**one blob file** in jbox under `aimdware/$COURSE/`, with `verified=true`.

## Model
`aimdware/deepseek-chat` (cheapest, fastest on this gateway).

## Prompt verbatim

```
Write a Python one-liner that reverses a string. Just the code, no
explanation, no markdown fences.
```

## How to run

```bash
source ./test-functional/bringup.sh
cd test-functional   # so opencode picks up our local opencode.json
opencode run --model aimdware/deepseek-chat \
  "Write a Python one-liner that reverses a string. Just the code, no explanation, no markdown fences."
cd ..
sleep 4
./test-functional/inspect.sh
./test-functional/teardown.sh
```

## Expected

- 1 row in `context_records`, `blob_status=uploaded`, `turn_count=1`
- 1 file under `aimdware/$COURSE/` on jbox
- `/admin/session/<id>/payload` returns `verified: true`, with
  `payload.messages` containing the user prompt and `payload.latest_response`
  containing the assistant reply (`s[::-1]`).
