# Student setup — step by step

This walks you from nothing to a working router capturing a **demo
assignment** end to end:

1. what your TA gives you
2. get the `aimdware-router` binary
3. install + configure **Tbox** (your jBox WebDAV gateway)
4. pick your upstream LLM
5. write `aimdware.yaml`
6. start the router and verify it's healthy
7. point your coding agent at it
8. run the demo assignment and confirm a capture landed
9. troubleshooting

> The router is a **visibility tool**, not enforcement. It runs on your
> own machine with your own credentials. See
> [threat-model.md](threat-model.md).

---

## 0. What your TA gives you

Before you start, get these four values from your TA (out of band — Feishu/email):

| Value | Example | Used as |
|---|---|---|
| Student token | `st_9aBx…` | `student_token` — treat as a password |
| Backend URL | `https://aimdware.example.edu` | `backend_url` |
| Course code | `DEMO101` | `course` |
| Assignment slug | `demo1` | `assignment` (chars: `A–Z a–z 0–9 _ . -`) |

The token is minted per student (`aimdware-admin token issue`). If it
ever leaks, ask your TA to rotate it.

---

## 1. Get the router binary

**Option A — download a prebuilt binary** (no toolchain needed). Grab the
one for your platform and rename it to `aimdware-router`:

```
aimdware-router-macos-arm64      # Apple Silicon
aimdware-router-macos-x64        # Intel Mac
aimdware-router-linux-arm64
aimdware-router-linux-x64
aimdware-router-windows-x64.exe
```

```bash
chmod +x aimdware-router            # macOS/Linux
./aimdware-router --help
```

> macOS Gatekeeper may block an unsigned binary. If so:
> `xattr -d com.apple.quarantine ./aimdware-router`.

**Option B — build from source** (needs [Bun](https://bun.sh) ≥ 1.3):

```bash
cd llm-client
bun install
bun run build                 # → dist/aimdware-router (current platform)
# or all platforms at once:
bun run build:all             # → dist/aimdware-router-<platform>
./dist/aimdware-router --help
```

Pick a working directory and keep the binary + your `aimdware.yaml`
together there.

---

## 2. Install and configure Tbox (your WebDAV target)

The router never stores your conversations itself — it **PUTs** each
captured blob to a WebDAV endpoint **you** control. The reference setup
is **jBox via Tbox**: Tbox runs a small local WebDAV server backed by
your jBox cloud storage.

> **Not at SJTU / no jBox?** Any WebDAV server works (NextCloud, a
> self-hosted `webdav-server`, minio + a WebDAV frontend …). Skip to the
> three values you need at the end of this section and plug in your own
> endpoint.

### 2.1 Download and sign in

1. Open the jBox portal: **https://jbox.sjtu.edu.cn**.
2. Download the **Tbox** desktop client for your OS and install it.
3. Launch it and sign in with **jAccount**.

### 2.2 Turn on the local WebDAV endpoint

In Tbox's settings, find the **WebDAV / local mount** section and note
three things (labels vary by Tbox version):

| You need | Goes into | Typical value |
|---|---|---|
| Local WebDAV URL | `tbox_url` | `http://127.0.0.1:50471` |
| WebDAV username | `tbox_user` | your jAccount, e.g. `alice` |
| WebDAV password / app token | `tbox_pass` | the token Tbox shows |

> The port differs per machine/version — use whatever Tbox displays, not
> the example above.

### 2.3 Verify WebDAV is reachable

With Tbox running, this should return `200`/`207` (not "connection
refused"). Replace the URL/creds with yours:

```bash
curl -u alice:<tbox_pass> -X PROPFIND http://127.0.0.1:50471/ -I
```

You do **not** need to pre-create any folders — the router creates
`aimdware/<course>/<assignment>/` automatically (MKCOL) on first upload.

---

## 3. Pick your upstream LLM

Choose **one** of these. It decides the `upstream:` block in step 5.

### 3a. An OpenAI-compatible API (key-based)

Anything that speaks the OpenAI API: the SJTU models gateway, OpenAI,
OpenRouter, DeepSeek, Kimi, GLM, Qwen, … You supply a `base_url` and
`api_key`.

```yaml
upstream:
  plugin: openai
  base_url: https://models.sjtu.edu.cn/api/v1
  api_key: sk-...
```

### 3b. ChatGPT / Codex subscription (no API key)

Uses your ChatGPT login instead of a key. Log in once (see step 6.1) and
set:

```yaml
upstream:
  plugin: codex
```

Codex is a **Responses-only** provider — point clients at
`/v1/responses` (not `/v1/chat/completions`).

### 3c. GitHub Copilot subscription

```yaml
upstream:
  plugin: copilot
```

For 3b/3c the tokens live in `local_cache_dir/auth/auth.json`, **not** in
`aimdware.yaml`.

---

## 4. Write `aimdware.yaml`

Create `aimdware.yaml` next to the binary. Full annotated example for the
demo assignment using an OpenAI-compatible upstream:

```yaml
# --- identity (from your TA) ---
student_token: st_REPLACE_ME
course: DEMO101
assignment: demo1
backend_url: https://aimdware.example.edu

# --- upstream LLM (pick ONE block from step 3) ---
upstream:
  plugin: openai
  base_url: https://models.sjtu.edu.cn/api/v1
  api_key: sk-REPLACE_ME

# --- WebDAV target (from Tbox, step 2) ---
tbox_url: http://127.0.0.1:50471
tbox_user: REPLACE_ME
tbox_pass: REPLACE_ME

# --- optional (defaults shown) ---
# port: 12345                       # where the router listens
# local_cache_dir: ~/.cache/aimdware
# jbox_remote_path: aimdware/DEMO101/demo1   # must equal aimdware/<course>/<assignment>
```

Lock the file down — it holds secrets:

```bash
chmod 600 aimdware.yaml
```

---

## 5. (Codex/Copilot only) log in

Skip if you chose 3a. Otherwise run the one-time device login:

```bash
./aimdware-router --config ./aimdware.yaml auth login codex
#   → opens https://auth.openai.com/codex/device, enter the printed code
./aimdware-router --config ./aimdware.yaml auth login copilot   # for copilot

./aimdware-router --config ./aimdware.yaml auth status
#   codex: logged in token=…        (redacted)
```

The access token auto-refreshes; you won't normally log in again.

---

## 6. Start the router and verify

```bash
./aimdware-router --config ./aimdware.yaml
```

On startup it prints a config summary (port, upstream, cache dir). In a
second terminal, confirm it's up:

```bash
curl -s http://127.0.0.1:12345/healthz        # → 200
```

Quick forward test (OpenAI-compatible upstreams):

```bash
curl -s http://127.0.0.1:12345/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer anything' \
  -d '{"model":"<a model your upstream offers>",
       "messages":[{"role":"user","content":"say hi"}]}'
```

You should get a normal completion back. The router listens on loopback
only and accepts **any** non-empty `api_key` from your agent — the real
upstream credential is the one in `aimdware.yaml`.

---

## 7. Point your coding agent at the router

Set your agent's base URL to the router and use any dummy key. Examples:

**OpenAI SDK / generic env:**

```bash
export OPENAI_BASE_URL=http://127.0.0.1:12345/v1
export OPENAI_API_KEY=dummy
```

**Codex / Responses clients** (when `plugin: codex`): point them at
`http://127.0.0.1:12345/v1/responses`.

Whatever tool you use (Cline, Aider, OpenCode, Cursor, curl, …), the
rule is the same: **base URL → the router, key → anything**.

---

## 8. Run the demo assignment and confirm capture

1. Make sure **Tbox is running** and the router is up (steps 2, 6).
2. Do one real model call through your agent (or the curl in step 6).
3. Watch the router log — you'll see a line like:

   ```
   captured record=… session=… turn=1 hash=…… size=… -> queued
   ```

4. Confirm the local blob exists:

   ```bash
   ls ~/.cache/aimdware/records/        # one <session_id>.json
   ```

5. Confirm it reached jBox — the file appears under:

   ```
   aimdware/DEMO101/demo1/<session_id>.json
   ```

   (visible in jBox/Tbox; the router PUTs it via WebDAV).

6. Your TA can now see the metadata + fetch the blob for `DEMO101/demo1`.

A multi-turn conversation collapses into **one** session file that is
overwritten each turn — that's expected (see
[design-notes.md](design-notes.md)).

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `failed to read config at …` | wrong `--config` path | use the correct path / `cd` to the dir |
| Config validation error on `api_key` | `plugin: openai` needs `api_key` | add it, or switch to `codex`/`copilot` |
| `jbox_remote_path must be aimdware/<course>/<assignment>` | overrode it with a non-canonical value | delete the override or match exactly |
| `Codex subscription is not logged in` | no/expired login | `auth login codex` |
| `Codex … refresh rejected … run auth login codex` | refresh token revoked | `auth login codex` again |
| Captures stay queued, never upload | Tbox down / wrong `tbox_*` | start Tbox; re-check URL/user/pass (step 2.3) |
| `does not support /v1/chat/completions` | `plugin: codex` got a Chat request | call `/v1/responses` instead |
| Agent calls fail with 4xx | wrong upstream `base_url`/model | verify with the step 6 curl |

Cache files in `local_cache_dir` are safe to delete; they're rebuilt
from upstream/Tbox as needed. The SQLite outbox retries across restarts,
so a backend or Tbox outage loses no data — captures upload once the
endpoint is back.
