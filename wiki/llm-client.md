# LLM client

Single binary on the student's machine. Sits between the coding agent
and an OpenAI-compatible upstream. Three things happen per chat call,
all off the student's critical path:

1. **forward** the request to upstream, stream the response back to the
   client byte-for-byte;
2. **capture** the request bytes + response bytes into a session-keyed
   blob on local disk;
3. **relay** the metadata to the backend over HTTP and the blob to a
   WebDAV endpoint the student controls (jbox via Tbox by default,
   but **any** WebDAV-compatible store works — see below).

## Config

```yaml
student_token: st_... # one per student; TT hands it directly
course: ECE4721J # course code slug; sent with every ingest call
assignment: hw1 # TT-decreed slug; A-Z/a-z/0-9/_.-
upstream:
  type: openai # default; only openai supported in v1
  base_url: https://models.sjtu.edu.cn/api/v1
  api_key: sk-... # student's own
port: 12345 # router listens here
local_cache_dir: ~/.cache/aimdware # outbox + blob cache
backend_url: https://aimdware.example.edu
# WebDAV target (NOT necessarily jbox — any compliant endpoint)
tbox_url: http://127.0.0.1:50471
tbox_user: alice
tbox_pass: <password or app token>
# Optional: must match the canonical default = aimdware/<course>/<assignment>
# jbox_remote_path: aimdware/ECE4721J/hw1
```

### What the router holds and what it doesn't

| Credential | Where | What it can do |
|---|---|---|
| `student_token` | `aimdware.yaml`, mode 600 | POST to backend `/ingest/*` |
| `upstream.api_key` | same file | call the student's chosen LLM provider |
| `tbox_user`/`tbox_pass` | same file | PUT to the student's chosen WebDAV |
| **NOT held**: backend admin secret, TT credentials, other students' data |

If `aimdware.yaml` leaks, all three secrets are compromised. The
backend can mint a new `student_token` via `aimdware-admin token issue`;
LLM provider and WebDAV credentials are the student's own to rotate.

### Why "tbox_*" instead of "webdav_*"

Historical: we developed against Tbox (a jbox WebDAV gateway). The
router is genuinely WebDAV-agnostic — point it at any endpoint that
speaks PUT + MKCOL and you're fine. NextCloud, minio + webdav frontend,
a self-hosted webdav-server, all work. The field names are stuck for
now; the docs are honest about the generality.

## What lands on disk

Three on-disk artifacts in `local_cache_dir`:

```
queue.db                          SQLite outbox (worker state)
queue.db-wal, queue.db-shm        WAL files
records/<session_id>.json         per-session blob; overwritten each turn
```

The `records/` files are **session-keyed** (Design A). Each new turn of
a multi-turn conversation overwrites the same file with the updated
state. A 50-turn agent run produces **one** file, not 50.

## Output

OpenAI-compatible Chat Completions at `http://127.0.0.1:<port>`. Coding
agent points its `base_url` here with any non-empty `api_key`.
Loopback-only; no inbound auth.

## Capture pipeline

```
inbound POST /v1/chat/completions
        │
        ▼
   handler.ts ── forward to upstream ──► response stream tee'd
        │                                   │
        │                                   ├──► client (verbatim)
        │                                   └──► capture buffer
        │
   capture.ts: emit { request_bytes, response_bytes }
        │
   session.ts: classify into a session via prefix-extension
        │       (if next request's messages strictly extends prior tip
        │        of session S → same session_id + turn_count++)
        ▼
   session-blob.ts: build the blob JSON for jbox
        │
   writeAtomic: <local_cache>/records/<session_id>.json
        │
   outbox.enqueue(record_id, session_id, turn_count, ...)
        │
   ── HTTP returns to client ──
```

Capture never blocks the client response. Per-call latency added by
the router on the critical path is ~ms (one read + one buffer copy +
SHA stream).

## Session identification

SessionTracker (in `src/recording/session.ts`) treats two requests as
the **same session** iff the second's `messages` array is a strict
prefix-extension of the first's tip:

```
prior.tip:  [system, user1, assistant1, user2]
next:       [system, user1, assistant1, user2, assistant2, user3]   ✓ extends
next:       [system, user1, assistant1, user2-edited]               ✗ different content at index 3
next:       [system, user1, assistant1]                             ✗ shorter
```

Comparison uses a recursive `canonicalize` (sort keys at every nesting
level, then JSON.stringify) so a client that re-orders message keys
between turns still merges to one session.

**What this is good for**: a vanilla OpenAI SDK doing multi-turn chat —
N HTTP calls collapse to 1 jbox blob, O(N) storage instead of O(N²).

**What this doesn't catch**: agent orchestrators (opencode/Sisyphus,
autogen, CrewAI, etc.) that spawn parallel sub-conversations with
different system prompts. Those are *legitimately* distinct sessions
and get their own blobs each. See [design-notes.md](design-notes.md).

LRU capacity: 32 active sessions per router process. In-memory only —
restarting the router starts fresh.

## Outbox + relay

Outbox is a SQLite table (`outbox` in `queue.db`). Each captured turn
becomes one row keyed by `record_id`. Schema:

```
record_id        PK   one HTTP call = one row
session_id       indexed; identifies the shared blob file
body_json        the metadata to send to backend
state            captured → ingested → synced → done | conflict | fatal
attempts         retry counter
next_attempt_at  exponential backoff
created_at
cache_evicted    0/1, set when records/<session_id>.json gets reclaimed
claimed_at       atomic claim for multi-worker safety
```

**State machine** (each transition is one HTTP call on success):

```
captured ── POST /ingest/context ──────────► ingested
ingested ── PUT  <tbox_url>/<blob_uri> ────► synced
synced   ── POST /ingest/context/<id>/uploaded ──► done
```

**Atomic claim**: `relay.ts`'s `runOnce` uses `UPDATE … RETURNING` to
claim a batch of N records in one SQL statement; two workers (even
across processes on the same `queue.db`) can't grab the same row.
Stale claims (held by a worker that crashed mid-process) become
re-claimable after 60s.

**Retries**: per-stage exponential backoff:
`1s → 5s → 30s → 5m → 30m → 1h`. State stays in the queue across
router restarts. A 5-day backend outage produces no data loss.

**Concurrency**: 4 in-process workers process the batch in parallel.
SQLite WAL + `busy_timeout = 5000` keeps it safe across multiple
router processes too.

## Eviction

Session-keyed blob cache is reclaimable when **every** record sharing
that `session_id` has reached a terminal state (`done`, `conflict`, or
`fatal`) AND the latest of them was created more than `ttlMs` ago
(default 24 hours). One delete per session; all member records get
`cache_evicted = 1`.

The queue row itself never deletes — it remains a per-record audit
trail on the student's disk.

## Multi-target build

`bun run build:all` produces five binaries (~95 MB each, Bun runtime
embedded):

```
dist/aimdware-router-macos-arm64
dist/aimdware-router-macos-x64
dist/aimdware-router-linux-arm64
dist/aimdware-router-linux-x64
dist/aimdware-router-windows-x64.exe
```

Student install path: download the binary for their platform, drop
`aimdware.yaml` next to it, `./aimdware-router --config aimdware.yaml`.

## Request flow (with blob path)

```
coding agent          router              upstream LLM       backend         WebDAV (jbox)
   │ POST /v1/chat     │                       │                │                  │
   ├──────────────────▶│                       │                │                  │
   │                   │ POST /v1/chat (key    │                │                  │
   │                   │   rewritten)          │                │                  │
   │                   ├──────────────────────▶│                │                  │
   │                   │ streaming SSE         │                │                  │
   │   relay SSE       │                       │                │                  │
   │◀──────────────────│                       │                │                  │
   │                   │  classify session,    │                │                  │
   │                   │  write blob to cache  │                │                  │
   │                   │                                                           │
   │                   │ POST /ingest/context  │                │                  │
   │                   ├───────────────────────────────────────▶│                  │
   │                   │           202 / 200                                       │
   │                   │◀───────────────────────────────────────│                  │
   │                   │ PUT  /aimdware/<course>/<assignment>/<session>.json       │
   │                   ├──────────────────────────────────────────────────────────▶│
   │                   │                                        201                │
   │                   │◀──────────────────────────────────────────────────────────│
   │                   │ POST /ingest/context/<id>/uploaded                        │
   │                   ├───────────────────────────────────────▶│                  │
   │                   │            200                                            │
   │                   │◀───────────────────────────────────────│                  │
```

## What's captured in the blob

See the schema in [backend.md → "Admin payload endpoints"]. Source of
truth is `src/recording/session-blob.ts`:

```jsonc
{
  // router metadata (NOT in the request body)
  "session_id":      "...",
  "course":          "ECE4721J",
  "assignment":      "hw1",
  "started_at":      "...",
  "latest_ts":       "...",
  "turn_count":      N,
  "upstream":        { "type": "openai" },
  "upstream_status": 200,

  // the entire request body the LLM saw, verbatim
  "request": {
    "model":           "...",
    "messages":        [...],
    "tools":           [...],
    "tool_choice":     "...",
    "temperature":     ...,
    "max_tokens":      ...,
    /* any other field the client sent */
  },

  // the upstream response, parsed if JSON, raw SSE string if streaming
  "response": { ... }
}
```

Sampling params (temperature, top_p, …), tools, response_format,
seed — anything the request carried — survives intact. If OpenAI adds
a new parameter tomorrow, the router captures it without a code
change.

## Tested with 1-5 MB payloads

`src/recording/large-payload.test.ts` pins:

- 1 MB user message → blob preserves verbatim, sha256 valid, <500 ms
- 1 MB tools array → all 200 schemas round-trip
- 1 MB SSE response → raw string preserved including `[DONE]`
- SessionTracker prefix-extend on 1 MB conversation → <1 s
- 10 × 1 MB concurrent sessions in LRU → no quadratic blowup

Realistic upper bound: ~5 MB. Beyond that the upstream itself rejects
the request (over its context-window) before the router sees it.
