# LLM client

Single package on the student's machine. Sits between the coding agent
and the upstream LLM. After each request:

- **metadata + hash** → POST to backend (`/ingest/context`)
- **full prompt + response JSON** → uploaded to the student's jbox via
  `rclone` shelling out against a locally-running Tbox WebDAV endpoint
  (Tbox wraps jbox in WebDAV using the student's jaccount)

Both happen in parallel, both off the student's critical path.

## Config

```yaml
student_token: st_... # one per student; TT hands it directly
course: ECE4721J # course code; sent with every ingest call
upstream:
  base_url: https://api.openai.com # default; overridable
  api_key: sk-... # student's own
port: 12345 # router listens here; coding agent points at it
local_cache_dir: ~/.cache/aimdware # router-owned buffer
jbox_remote_path: aimdware/<course> # target path inside jbox cloud
backend_url: https://aimdware.sjtu.edu # hardcoded per build / overridable via flag
```

`student_token` is one credential per student; `course` selects which
course context this router instance reports to. A student enrolled in
multiple courses runs one router instance per course (different `port`
and `course`), or a single instance with multi-course config (post-v1).

The router holds no jbox credential — auth lives inside Tbox.

### Token storage and rotation

The `student_token` plaintext is **the only long-lived copy** of the
credential. The backend stores only `sha256(token)`. Implications:

- `config.json` is written with mode `600`; the router never logs the
  plaintext (`student_token` is on the redact list).
- If the laptop / config file is compromised, treat the token as leaked
  and ask the TT to run `aimdware-admin token rotate --user <jaccount>`.
  This invalidates the leaked token at the next backend request and
  prints a new plaintext to paste into config.
- If the student loses the token, the same rotate flow is the only
  recovery — we cannot read back the old one from the backend.

## Output

OpenAI-compatible Chat Completions at `http://127.0.0.1:<port>`. Coding
agent points its `base_url` here with any non-empty `api_key`.
Loopback-only; no inbound auth.

## Auth and provider

Check the impl of [opencode](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/)

## Sync engine

The student runs two local processes:

- **[Tbox](https://github.com/1357310795/TboxWebdav)** — exposes jbox as
  a local WebDAV endpoint on the student's machine. Authenticates to
  jbox with the student's jaccount; launched once at setup.
- **The router** — uses `rclone` as the transport, shelling out to the
  `rclone` binary to push files against the Tbox WebDAV endpoint.

The router holds no jbox secret; the credential lives inside Tbox.

Sync engine behavior:

- Each captured response is written atomically to
  `local_cache_dir/{record_id}.json`.
- A worker watches the cache and invokes
  `rclone copy {cache_file} tbox:{jbox_remote_path}/` per blob
  (`tbox:` is the rclone remote pre-configured to point at the local
  Tbox WebDAV endpoint).
- Per-blob state tracked on disk: `pending → uploading → synced → failed`.
- Exponential backoff on transient failures; persistent failures surfaced
  on the router's status page.
- Already-`synced` blobs are never re-uploaded (delta-aware).
- Queue + state survive restarts.
- After backend confirms `uploaded` via `/ingest/context/{id}/uploaded`,
  the local cache copy is eligible for eviction (default: 7-day grace,
  hard cache-size cap with LRU eviction).

## Request flow

```
coding agent     router               upstream LLM   backend    jbox
   │ POST /chat   │                       │             │         │
   ├─────────────▶│ POST /chat (auth      │             │         │
   │              │   rewritten)          │             │         │
   │              ├──────────────────────▶│             │         │
   │              │ streaming SSE         │             │         │
   │   relay SSE  │ (parallel: JSON,      │             │         │
   │◀─────────────│  sha256, local cache) │             │         │
   │              │ POST /ingest/context  │             │         │
   │              ├──────────────────────────────────────▶        │
   │              │           202 (pending)             │         │
   │              │◀──────────────────────────────────────│        │
   │              │ (sync engine) rclone copy → tbox WebDAV       │
   │              │ → jbox cloud                                  │
   │              ├──────────────────────────────────────────────▶│
   │              │                                     │  synced │
   │              │◀──────────────────────────────────────────────│
   │              │ POST /ingest/context/{id}/uploaded  │         │
   │              ├──────────────────────────────────────▶        │
   │              │           202 (uploaded)            │         │
   │              │◀──────────────────────────────────────│        │
```

## Tech stack

Bun, compiled to a single binary per OS. Vercel AI SDK / `openai-node`
cover most upstream work.

## Distribution

Pre-built binaries on Gitea releases (Linux x64, macOS x64+arm64,
Windows x64). Install via `curl install.aimdware.sjtu.edu | sh`.
