# Test 5 — context compression vs SessionTracker

## Goal
opencode (like Claude Code) summarises older turns when the conversation
approaches the model's context window. **This rewrites earlier messages**
— they're replaced by a short summary string.

Our `SessionTracker.classify` requires the next request's `messages`
to be a **strict prefix-extension** of the prior tip. After compression,
the prefix changes — so:

- BEFORE compression: turns 1..N share one session_id, one jbox file
- AT compression: turn N+1's `messages` is **NOT** an extension of turn
  N's → SessionTracker classifies it as a **new session** → new
  session_id, new jbox file

That's the **expected** behavior. This test documents it explicitly so
TT folks understand why one logical agent run can produce 2+ jbox files
when it's long.

## Prompt verbatim

```
Let's brainstorm a long, exhaustive, exploratory list. I want 30 distinct
ideas for a CS undergraduate capstone project at SJTU, each with 3 lines
of detail: (a) one-line description, (b) the hardest sub-problem, (c)
which course in the SJTU JI curriculum it builds on most naturally.
Number them 1 through 30. After ideas 15, give me a brief mid-point
summary of common themes. After idea 30, give a final synthesis. Be
verbose; quality beats brevity here.
```

This is engineered to be long enough that opencode may compress
mid-stream, especially if the agent stalls and we follow up. If the
single response doesn't trigger compression, send a follow-up:

```
Now expand idea #7 with three potential thesis-supervisor candidates
and what each would want to see in the proposal.
```

…and continue with two more follow-ups until compression visibly fires
(opencode logs it; we can also tell by the `messages` shrinking in the
captured blob across turns).

## Model

`aimdware/deepseek-reasoner` (longer answers + bigger context budget,
better chance of triggering compression).

## How to run

```bash
source ./test-functional/bringup.sh
cd test-functional
opencode run --model aimdware/deepseek-reasoner "<prompt above>"
# follow-ups in the same session: use opencode's --continue / session id
cd ..
./test-functional/inspect.sh
```

## Expected (assuming compression fires)

- Backend: turns 1..K share `session_id_A`; turns K+1..N share
  `session_id_B`. Both blobs in jbox.
- The first turn after compression has a much **shorter** `messages`
  array than the last turn before. That's the signal.

## Expected (assuming compression does NOT fire)

- Single session_id across all turns. One jbox file. blob_size grows
  monotonically with `turn_count`.

## What to record

For each transition between adjacent records:

```
ts                turn_count  session_id  msg_count  blob_size
...               1           A           1          567
...               2           A           3          821
...               3           A           5          1124
...               4           B           7          740     ← compression!
```

Save this table into `runs/<workdir>/05-compression-trace.md`.
