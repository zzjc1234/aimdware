# Student Deployment Guide

This guide is for students: download `aimdware-router`, configure Tbox/jBox, create one config file per assignment, start the router, and confirm uploaded records in jBox.

## 0. Required Information

Project links:

1. [TboxWebdav](https://github.com/1357310795/TboxWebdav)
2. [aimdware GitHub release](https://github.com/zzjc1234/aimdware/releases/tag/v0.1.0)

Your TA will give you these values:

| Name | Example | Used as |
| --- | --- | --- |
| Student token | `st_...` | `student_token`; keep it private |
| Backend URL | `https://aimdware.example.edu` | `backend_url` |
| Course code | `ECE4721J` | `course` |
| Assignment slug | `hw1`, `lab2`, `project` | `assignment` |

`course` and `assignment` may only contain English letters, digits, underscores, dots, and hyphens. Do not use Chinese characters, spaces, or slashes.

## 1. Download Router

After release, open the GitHub release page and download the latest version:

```text
https://github.com/zzjc1234/aimdware/releases
```

Put the downloaded file in a stable directory:

```bash
mkdir -p ~/aimdware

# If you downloaded the Release binary:
mv ~/Downloads/aimdware-router-macos-arm64 ~/aimdware/aimdware-router

cd ~/aimdware
chmod +x ./aimdware-router
./aimdware-router --help
```

On macOS, if Gatekeeper blocks the downloaded binary, run:

```bash
xattr -d com.apple.quarantine ./aimdware-router
```

## 2. Configure Tbox and jBox

The router does not store your conversation content itself. It uploads captured JSON files to your own jBox through Tbox.

1. Open jBox: `https://jbox.sjtu.edu.cn`
2. Download and install the Tbox desktop client.
3. Sign in to Tbox with jAccount.
4. Find the WebDAV/local service settings in Tbox.
5. Note these three values:

| Tbox value | Config field | Example |
| --- | --- | --- |
| Local WebDAV URL | `tbox_url` | `http://127.0.0.1:50471` |
| WebDAV username | `tbox_user` | `admin` |
| User token | `tbox_pass` | `UserToken` in the Tbox config |

Use the port shown by your own Tbox. Do not blindly copy the example port.

Use `demo.sh` to test Tbox:

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="${TBOX_URL:-http://127.0.0.1:50471}"
USER="${TBOX_USER:-admin}"
TOKEN="${TBOX_USER_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  printf "Tbox UserToken: " >&2
  stty -echo
  read -r TOKEN
  stty echo
  printf "\n" >&2
fi

DIR="aimdware-test-$(date +%s)"
FILE="$(mktemp)"
trap 'rm -f "$FILE"' EXIT

printf ok > "$FILE"

echo "1. Check WebDAV root"
curl -fsS -u "$USER:$TOKEN" -H "Depth: 0" -X PROPFIND "$BASE/" >/dev/null

echo "2. Create test directory: $DIR"
curl -fsS -u "$USER:$TOKEN" -X MKCOL "$BASE/$DIR" >/dev/null

echo "3. Upload probe.txt"
curl -fsS -u "$USER:$TOKEN" -T "$FILE" "$BASE/$DIR/probe.txt" >/dev/null

echo "4. Read probe.txt"
curl -fsS -u "$USER:$TOKEN" "$BASE/$DIR/probe.txt"
printf "\n"

echo "5. Delete probe.txt"
curl -fsS -u "$USER:$TOKEN" -X DELETE "$BASE/$DIR/probe.txt" >/dev/null

echo "6. Delete test directory"
curl -fsS -u "$USER:$TOKEN" -X DELETE "$BASE/$DIR" >/dev/null

echo "Tbox WebDAV check passed"
```

Run it with:

```bash
TBOX_USER_TOKEN=<Your-TBOX_USER_TOKEN> bash demo.sh
```

Replace `Your-TBOX_USER_TOKEN` with the top-level `UserToken` in your Tbox config. If the script passes, Tbox is reachable and upload works. `connection refused` usually means Tbox is not running or the port is wrong.

## 3. Create a Config File

Create `aimdware.hw1.yaml` in `~/aimdware`:

```yaml
student_token: st_REPLACE_ME
course: ECE4721J
assignment: hw1
backend_url: http://111.186.57.145:4312

tbox_url: http://127.0.0.1:50471
tbox_user: admin
tbox_pass: TBOX_USER_TOKEN

upstream:
  plugin: openai
  base_url: https://models.sjtu.edu.cn/api/v1
  api_key: sk_REPLACE_ME

# Optional; default is 12345.
# port: 12345

# Optional; default upload path is aimdware/<course>/<assignment>.
# Do not set jbox_remote_path manually unless you know why; a mismatch fails startup.
```

The config file contains tokens and passwords. Restrict its permissions:

```bash
chmod 600 aimdware.hw1.yaml
```

### HTTP/HTTPS Rules

Use these rules. Do not mix them up:

| Config field | Typical value | Notes |
| --- | --- | --- |
| `backend_url` | `https://...` or `http://...` | Use what your TA gives you. Production usually uses HTTPS; test/internal deployments may use HTTP. |
| `tbox_url` | `http://127.0.0.1:<port>` | Tbox runs a local WebDAV service on your own computer, usually over HTTP. |
| `upstream.base_url` | `https://...` | SJTU/OpenAI/DeepSeek and other online model gateways usually use HTTPS. |
| `OPENAI_BASE_URL` | `http://127.0.0.1:12345/v1` | Your AI tool connects to the local router over HTTP. |

If your upstream model is a local service, such as Ollama or a local OpenAI-compatible gateway, HTTP is fine:

```yaml
upstream:
  plugin: openai
  base_url: http://127.0.0.1:11434/v1
  api_key: dummy
```

If you need a proxy for HTTPS upstreams or Codex login, set only `HTTPS_PROXY`:

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
./aimdware-router --config ./aimdware.hw1.yaml
```

Usually do not set `HTTP_PROXY`. The local router and Tbox both use `http://127.0.0.1`, so keeping them direct is simplest.

If you use a ChatGPT/Codex subscription instead of an API key, replace `upstream` with:

```yaml
upstream:
  plugin: codex
```

Then log in once:

```bash
./aimdware-router --config ./aimdware.hw1.yaml auth login codex
./aimdware-router --config ./aimdware.hw1.yaml auth status
```

If you use an Anthropic-compatible API, configure that router instance with:

```yaml
upstream:
  plugin: anthropic
  base_url: https://api.anthropic.com
  api_key: sk-ant-REPLACE_ME
```

Point Anthropic-compatible clients at `http://127.0.0.1:12345/v1/messages`.

## 4. Create Configs for Multiple Assignments

Use one config file per assignment. Usually only `assignment` changes.

```bash
cp aimdware.hw1.yaml aimdware.hw2.yaml
```

Change this in `aimdware.hw2.yaml`:

```yaml
assignment: hw1
```

to:

```yaml
assignment: hw2
```

Recommended names:

```text
aimdware.hw1.yaml
aimdware.hw2.yaml
aimdware.lab1.yaml
aimdware.project.yaml
```

Start the router with the config for the assignment you are working on. Do not keep using the `hw1` config while working on `hw2`, or files will upload to the wrong directory.

## 5. Startup Checklist

Before starting each assignment, check:

1. Tbox is signed in and its WebDAV local service is running.
2. The `assignment` field in the config matches the current assignment.
3. Start the router:

```bash
cd ~/aimdware
./aimdware-router --config ./aimdware.hw1.yaml
```

You should see output like:

```text
aimdware-router listening on http://127.0.0.1:12345
  course:      ECE4721J
  backend:     https://aimdware.example.edu
  tbox:        http://127.0.0.1:50471
```

In another terminal, check health:

```bash
curl -s http://127.0.0.1:12345/healthz
```

If it returns `ok`, the router is running.

## 6. Point Your AI Tool at the Router

Set your AI tool's OpenAI base URL to the local router:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:12345/v1
export OPENAI_API_KEY=dummy
```

`OPENAI_API_KEY` can be any non-empty value. The real upstream credential is `upstream.api_key` in the config file, or your logged-in Codex token.

If you use `plugin: codex`, the tool must call the Responses API:

```text
http://127.0.0.1:12345/v1/responses
```

## 7. Confirm Upload

After one real model call, the router terminal should print a line like:

```text
captured record=... session=... turn=1 hash=... size=... -> queued
```

After a few seconds, open jBox or Tbox and check:

```text
aimdware/<course>/<assignment>/
```

For example:

```text
aimdware/ECE4721J/hw1/
```

You should see a file like:

```text
<session_id>.json
```

A multi-turn conversation usually stays in one session file. Later turns overwrite it with the latest complete state. This is expected.
