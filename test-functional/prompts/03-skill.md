# Test 3 — agent invokes a skill

## Goal
opencode "skills" are markdown files the agent reads as part of its
system prompt. When the agent uses one, it shows up in the request as
extra system / assistant turns. We want to verify that the router's
SessionTracker:

1. Treats the multi-turn dialogue (system + skill-bound user + assistant)
   as **ONE session**, not multiple.
2. The jbox blob's final `messages` array contains the full conversation
   including the skill content the agent loaded.

## Setup

Create a one-off skill under `test-functional/skills/string-tools/SKILL.md`
that defines a single trivial procedure. opencode's project-local
config discovers skills under `./skills/`.

## Prompt verbatim

```
Use the string-tools skill to reverse this string for me: "elephant".
After the reversal, count the unique consonants in the result and tell
me the number.
```

## Model

`aimdware/deepseek-chat`

## How to run

```bash
source ./test-functional/bringup.sh
cd test-functional
opencode run --model aimdware/deepseek-chat \
  "Use the string-tools skill to reverse this string for me: \"elephant\". After the reversal, count the unique consonants in the result and tell me the number."
cd ..
sleep 8           # multi-turn agent loop — give it room
./test-functional/inspect.sh
```

## Expected

- Backend: **≥2 records**, all sharing one `session_id`. (Agent
  typically does: turn 1 = first model call, turn 2 = post-skill model
  call.)
- jbox: **exactly one** blob file for that session.
- The blob's final `messages` array contains the system prompt with
  skill content, the user request, and any intermediate assistant +
  tool messages.
- `verified=true` on the latest record.
