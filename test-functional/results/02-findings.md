# Test 2 findings — multimodal input/output

## Setup
- model: `aimdware/qwen` (only SJTU model with working vision support;
  glm 500'd, minimax rejected as non-multimodal, deepseek-* obviously text-only)
- attachment: 1×1 transparent PNG (68 bytes), `-f 02-image.png` to opencode
- prompt: "I'm attaching a 1x1 transparent PNG. Describe what you see…"

## Router capture: WORKS

My pre-test direct curl probes (no opencode, just `image_url` parts in
JSON) produced blobs with the OpenAI multimodal structure preserved:

```json
"content": [
  { "type": "text",      "text": "What's in the image?" },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVB..." } }
]
```

`first_user_content_type: "array"`, parts `["text", "image_url"]`,
base64 data round-trips intact. The router's `tryParseJSON` +
`canonicalize` path handles array `content` correctly, as already
covered by `session-blob.test.ts`.

## opencode capture: image stripped by opencode's own Read tool

When opencode received `-f 02-image.png`, Sisyphus called its **internal
Read tool** rather than emitting `image_url` parts. The Read tool's
response surfaced as a user message:

```
[0] system: <Role> You are "Sisyphus"...
[1] user (4 text parts):
    [a] "Called the Read tool with the following input: {filePath:...02-image.png}"
    [b] "Image read successfully"
    [c] "ERROR: Cannot read 02-image.png (this model does not support
        image input). Inform the user."
    [d] "I'm attaching a 1x1 transparent PNG. Describe what you see..."
```

i.e. **Sisyphus base64-encoded zero bytes of the image**. The model
got 4 plain-text parts and no image data, then "described" the image
based on the filename + prompt alone.

**Where the gate is**: opencode's per-provider capability registry. Our
test-functional/opencode.json declares a custom `aimdware` provider
with no model-capability metadata. opencode's default assumption for
unknown providers is "text-only", so the Read tool blocks image bytes
from reaching the model.

## What gets captured under opencode + image attachment

Total: 2 new records (smaller than Test 1's 17 because Sisyphus didn't
loop on a multimodal failure — it just gave up at Read):

| blob       | size  | role                                  |
|------------|-------|---------------------------------------|
| e12a0fce…  | 5KB   | title-generator thread (text only)    |
| 55e5a81a…  | 46KB  | Sisyphus main thread (4 text parts; no image) |

Both `verified: true`. Router did its job.

## TT-relevant implications

1. **Students can't easily smuggle images past opencode-based UI**
   into custom providers — opencode's Read tool refuses.
2. **Students CAN smuggle images** by using a direct OpenAI-SDK call or
   raw curl (we proved this works end-to-end against qwen).
3. **The captured blob's `content` field is the source of truth** for
   what the student showed the model: array-of-parts means vision was
   actually invoked, string means it was text-only.

For TT auditing tools: when investigating "did student X show the
model an image", look for blobs where any
`messages[*].content[*].type == "image_url"` (or in the data-URI
fallback, check for `"data:image"` substring in any text part).

## To extend this test

We could tell opencode about the provider's vision capability via the
provider config (`"options.modelCapabilities"` or similar). That would
let `-f` produce real `image_url` parts. Worth doing if we want to
exercise the full multimodal path through opencode.

For now: **router multimodal capture is verified, opencode multimodal
relay is a known gap we now understand**.
