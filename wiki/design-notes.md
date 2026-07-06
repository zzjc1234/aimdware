# Design notes

Empirical findings from running the router against real LLM upstreams
(SJTU's models.sjtu.edu.cn) driven by real agent platforms (opencode
1.3.x + oh-my-opencode plugins). The architecture works; what these
notes capture is **what real-world load looks like** so a future
maintainer doesn't relitigate decisions from first principles.

## Session-keyed blobs (Design A)

**Problem we solved.** OpenAI Chat Completions is stateless. Multi-turn
chat re-sends the **full history** on every request. Naive
per-HTTP-call storage of the captured blob produces O(N²) total bytes
for an N-turn conversation. A 50-turn coding agent with 100 KB
messages each blows up to ~250 MB on jbox.

**What we do instead.** SessionTracker keeps an in-memory LRU of
"active sessions" (up to 32). On each capture:

1. Parse `request.messages` from the captured bytes.
2. For each active session, check whether the new `messages` is a
   **strict prefix-extension** of that session's last seen tip.
3. Match → same `session_id`, `turn_count++`, overwrite the existing
   jbox file with the new (larger) state. No match → new UUID,
   fresh session of 1 turn.

Result: 50 turns of one conversation → 1 jbox file → O(N) storage.

**Comparison key.** `messagesEqual` runs a recursive `canonicalize`
(sort object keys at every nesting level) before stringifying. A
client that re-orders `tool_calls` keys between turns still merges
correctly.

**What this does NOT merge.** When an agent orchestrator spawns
sub-agents with DIFFERENT system prompts (see below), each sub-agent's
calls form their own session. The merging is correct at the
semantic level; what would be wrong is forcing them into the same
session_id.

## Agent platform overhead

A "simple" opencode user task on this stack produces **15-30 jbox
files**, not 1. Empirically, for one prompt "Write a Python one-liner
that reverses a string":

| count | what it is |
|---|---|
| ~7 | Sisyphus main agent (the actual task runner) |
| ~6 | "summarizer" sub-threads ("What did we do so far?") |
| 1 | thread title generator |
| ... | per-task housekeeping |

These are **legitimately distinct conversations** — each has its own
system prompt + opening user message, so SessionTracker correctly
treats them as separate sessions. Trying to merge them by some heuristic
would lose semantic information (was this the user's task or a
title-generation sub-task?).

**TT-side implication.** "All the records from one student's `opencode
run` for assignment X" is **not** a single session_id query — it's a
time-window query on (user, course, assignment). The session_id
groups one logical conversation; one user task can produce many.

**For audit:** filter by `messages[0]` system-prompt hash to separate
"main thread" from "housekeeping threads" (title gen, summarizer).

## Compression behavior

When a client's context approaches the model's window, the client may
**compact** earlier turns into a summary. The next request's `messages`
is shorter than the prior tip and has different content at older
positions. This violates the strict-prefix invariant → SessionTracker
classifies it as a new session.

This is the correct behavior — the compacted conversation is
semantically different from what came before (older turns are now
summary placeholders). Audit needs to know that a session ended and a
new one began at compression time. We surface this naturally as a
session_id transition.

## What the router does NOT see

The router is a **MITM proxy at the LLM wire**. It captures everything
sent to or received from the LLM upstream. It **does not see**:

- Client-side internal tool calls that don't go through the LLM. If
  opencode's Read tool slurps a file into context, the router only
  sees the bytes that subsequently reach the LLM. If opencode decides
  to refuse the file (e.g., image attachments to a "non-vision"
  provider), the bytes never reach the LLM and the router has no record.
- LLM responses the client consumes but doesn't act on. (The router
  captures the full response stream, so this is rare.)
- Calls made through a different unmonitored client (vanilla `curl`,
  another `openai-python` binary the student installs side-by-side).

In our Test 2 (multimodal): opencode's Read tool intercepted an image
attachment, decided the configured provider didn't support vision,
substituted an error message into the prompt, and the LLM saw zero
image bytes. Router captured exactly what was sent. The image bytes
**never crossed the router**.

This is consistent with the [threat-model.md](threat-model.md): the
router provides visibility for compliant use, not enforcement against
adversarial clients.

## Multimodal: confirmed working through the router

Direct OpenAI-spec multimodal (`content: [{type: text}, {type:
image_url}]`) flows through the router with **byte-level fidelity**.
A 68-byte transparent PNG embedded as `data:image/png;base64,...` in
a `image_url` part round-tripped: SHA matched after we
`base64 -d`'d the blob's `image_url` content and compared to the
original file.

So:
- TT can recover any image the student showed the model by extracting
  `image_url` parts from the blob.
- Students using opencode's `-f file.png` flag for image attachments
  do NOT actually send the image (opencode strips it for unknown-
  capability providers). They have to configure provider capabilities
  in opencode.json, or use a non-opencode client, for the image to
  reach the LLM.

## The "tools" field is captured (post-Test 4)

Originally `buildSessionBlob` hand-picked fields off the request
(`model`, `messages`). Test 4 surfaced a 100 KB delta: opencode +
plugins + MCP advertise ~75 tools to the model in the request's
`tools` array, totalling ~25k tokens. We were silently dropping all
of it.

Fixed in commit `509a670`, then generalised in commit `42d4eed`: the
blob now carries the **entire parsed request body** under `request`.
Anything the model saw is preserved.

## Audit playbook

How a TT actually finds what student X did for assignment Y:

```bash
# 1) Token / DB-level work
aimdware-admin record list --user X --assignment Y
# returns rows sorted by ts, with session_id grouping visible

# 2) Group by session for the readable view
SESSIONS=$(... | jq -r .session_id | sort -u)
for sid in $SESSIONS; do
  aimdware-admin record payload --id <one record_id from that session>
  # or via HTTP: GET /admin/session/$sid/payload
done

# 3) Filter to "main" conversations (drop title-gen / summarizer noise)
#    by hashing messages[0] and grouping
... | jq -r '.payload | fromjson | .request.messages[0].content | @base64' | sort | uniq -c
```

For "did this student show the model an image":

```bash
... | jq '.payload | fromjson | .request.messages[]
              | (.content // []) | if type=="array" then
                  map(select(.type=="image_url")) else [] end
              | length' | grep -v '^0$'
```

For "did this student have filesystem access tools":

```bash
... | jq '.payload | fromjson | .request.tools // [] | map(.function.name)'
```

## Things explicitly deferred

- **Per-course admin authorization in `/admin/*`.** v1 is a shared
  secret with global read.
- **Session reconstruction across opencode-style orchestrators.** The
  data is captured; UI-level "show me everything for one user task"
  needs heuristics we haven't built.
- **Backend timeout on the WebDAV reader.** A hung jbox endpoint
  would hold one FastAPI worker indefinitely. Wrap with a timeout.
- **Router timeout on upstream calls.** Worker can stall on a hung
  HTTP connection; another worker takes the row at the stale-claim
  cutoff but the original worker leaks. Bound with AbortController.
