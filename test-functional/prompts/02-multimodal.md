# Test 2 — multimodal input/output

## Goal
Find out how the router represents an **image-bearing request** in the
captured blob. OpenAI-style chat completions encode images as
`content: [{type:"text",...}, {type:"image_url", image_url:{url:"data:image/png;base64,..."}}]`.

We want to confirm:

1. The router **does not break** vision requests (passthrough OK).
2. The captured blob preserves the structured `content` array intact —
   so a TT can see what image was sent.
3. blob_size grows accordingly (a base64 PNG of even 50KB inflates).

## Model

SJTU's GLM is the only model on this gateway with documented vision
support. We'll send to `aimdware/glm`. If GLM rejects it, fall back to
sending to a chat-only model — the router test still measures capture
behaviour, just the upstream will 400.

## Prompt verbatim

The literal request bodies live next to this file as:
- `02-multimodal-request.json`  (the request POST body, ready to curl)
- `02-multimodal-image.png`     (1×1 transparent PNG, base64-inlined in the request)

## How to run

```bash
source ./test-functional/bringup.sh
curl -sS -X POST "http://127.0.0.1:$ROUTER_PORT/v1/chat/completions" \
  -H "Authorization: Bearer ignored" \
  -H "Content-Type: application/json" \
  -d @test-functional/prompts/02-multimodal-request.json \
  | tee test-functional/runs/$(basename $WORK)/02-response.json

sleep 4
./test-functional/inspect.sh
```

## Expected

- Router accepts and forwards the multimodal payload.
- DB: 1 row, `turn_count=1`.
- Blob: `messages[0].content` is an **array of parts** (text + image_url).
  base64 data preserved inline. blob_size > size of a text-only message.
- `verified: true`.

## What to flag if it breaks

- If router crashes parsing the array content → bug in our capture/session logic.
- If blob's `messages[0].content` collapses to a string → JSON round-trip lossy.
