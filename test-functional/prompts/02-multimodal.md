# Test 2 — multimodal input/output

## Goal
Drive an image-bearing request **through opencode + Sisyphus through
the router** and observe:

1. Does the router faithfully proxy OpenAI's multimodal `content`
   schema (array of `{type:"text"|"image_url", ...}` parts)?
2. Does the captured blob preserve the image (base64 or url-pointer)
   exactly as sent, so a TT can verify what the student showed the LLM?
3. Does Sisyphus's orchestrator preserve the image part across its
   sub-agent introspection turns, or does it strip / re-serialize it?

## Model choice

Probed all 5 SJTU models with a base64-inlined PNG:

| model     | result                                                  |
|-----------|----------------------------------------------------------|
| deepseek-chat / deepseek-reasoner | not multimodal (not even tried)         |
| minimax   | `litellm.BadRequestError: ... is not a multimodal model` |
| glm       | `Hosted_vllmException - Internal Server Error` (5xx)     |
| **qwen**  | ✓ described the transparent PNG correctly                 |

Use `aimdware/qwen`.

The test image is `02-image.png` — a tiny 1×1 transparent PNG we
generate at runtime, base64-inlined into the request. Small enough to
not bloat blobs; presence is what we're checking, not content.

## Prompt verbatim

```
I'm attaching a 1×1 transparent PNG. Describe what you see in it
in one sentence. If the image is empty or transparent, say so.
```

## How to run

```bash
source ./test-functional/runs/$LATEST_RUN/env.sh
cd test-functional

# Generate the test PNG (1×1 transparent, ~70 bytes)
python3 -c "import base64,sys; sys.stdout.buffer.write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='))" > 02-image.png

opencode run --model aimdware/glm \
  -i 02-image.png \
  "I'm attaching a 1x1 transparent PNG. Describe what you see in it in one sentence. If the image is empty or transparent, say so."
cd ..

sleep 4
./test-functional/inspect.sh
```

## What to record

For each captured blob, check `messages[i].content`:

- If `content` is a string → text-only request (Sisyphus stripped the
  image or the upstream collapsed it)
- If `content` is an array of parts → multimodal preserved. Look for
  `type: "image_url"` entries and verify the base64 data survives
  intact (length + first/last 20 chars).

Save:
- `runs/<workdir>/02-findings.md` — the analysis
- Tag the blob that contained the actual image (if any) for visual
  inspection in jbox.

## Failure modes to flag

- Router crashes on array `content` (would mean our JSON.parse path
  doesn't tolerate arrays — but we already test that in
  `session-blob.test.ts`, so this should pass)
- GLM rejects the request entirely (likely if SJTU's "glm" alias
  isn't the vision variant)
- Sisyphus base64-decodes and re-encodes the image, mutating it
  (we'd see `image_url` base64 differ across turns)
