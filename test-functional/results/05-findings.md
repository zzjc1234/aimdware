# Test 5 findings — context compression effect on history

## Setup
- model: `aimdware/deepseek-reasoner` (128k context — gives headroom
  before forced compaction)
- prompt: "Enumerate the first 10 perfect squares, for each say if its
  digit sum is itself a perfect square."
- Intent: deepseek-reasoner is a thinking-trace model. Its responses
  are verbose. Combined with Sisyphus's orchestration, we expected
  to see compression behavior in action.

## What we observed

3 captures over ~3 minutes (killed at the cap):

| ts        | msgs | size      | thread             |
|-----------|------|-----------|--------------------|
| 11:27:32  | 2    | 43 KB     | Sisyphus main (sees user task) |
| 11:29:13  | 4    | 265 KB    | summarizer sub-thread |
| 11:29:42  | 3    | **371 KB**| title-generator sub-thread |

The msg-count went **2 → 4 → 3** — NOT extending. Each blob is
classified by SessionTracker as a separate session, correctly:

- blob 1: `system: <Sisyphus role>` + user task
- blob 2: `system: summarizer role` + user task + `What did we do so far?` + `Continue...`
- blob 3: `system: title-generator role` + `Generate a title:` + user task

Three different system prompts → three different `messages[0]` → three
separate sessions per our prefix-extension rule.

## The 371KB title-generator is the eye-opener

The biggest blob (371KB) is the title-generator thread. The
title-generator's job is trivial — emit a ≤50-char string naming the
conversation. But it received the **entire deepseek-reasoner assistant
output verbatim** as its user message [2]:

```
[0] system: "You are a title generator. Output ONLY a thread title..."
[1] user:   "Generate a title for this conversation:"
[2] user:   "<the full 350KB reasoner answer to the original task>"
```

So opencode pastes the WHOLE assistant response into a title-generator
sub-call. The title-generator runs the LLM again on 350KB of context
just to produce a 50-char title. **This is per-task overhead that
scales with the assistant response size**, not the user prompt size.

Implication for the router: a single user "small task" can produce
multiple multi-hundred-KB jbox uploads, each of which is the same
assistant content seen by a different sub-agent. Cost on jbox storage
grows fast.

## How compression affects what gets captured

We **did NOT** see opencode visibly compact the user's task itself
(unlike Test 4 where MCP context blew the window). What we DID see
matches an earlier pattern from Test 1's blob t2:

```
[3] user: "The previous request exceeded the provider's size limit
          due to large media attachments. The conversation was
          compacted and media files were removed from context. ..."
```

When opencode does compact, **it rewrites earlier messages in the
array** and re-sends. From our SessionTracker's strict-prefix
perspective, the post-compaction request is NOT a prefix-extension of
the pre-compaction request, so a new session_id is minted. The
compaction creates a session boundary.

## Conclusion across all 5 tests

| # | What it tested            | Router behavior      | opencode behavior                            |
|---|----------------------------|----------------------|----------------------------------------------|
| 1 | Single task                | ✓ captured 17 blobs  | Sisyphus loops + summarizers + title gen     |
| 2 | Multimodal                 | ✓ captures `image_url` parts | Read tool strips image for custom providers |
| 3 | Skill invocation           | ✓ captures `<skill>` listings | Agent inferred from description, didn't `skill`-tool-load |
| 4 | MCP                        | ✓ would capture tool_calls | Context overflow loop; never invoked MCP |
| 5 | Compression                | ✓ each rewrite = new session | Title-gen + summarizer add ≈700KB per real turn |

**Router-side**: every single capture across 5 tests has
`verified=true`. The router is correct end-to-end against the real
SJTU upstream.

**opencode + agent platform overhead**: a non-trivial issue we now
have data on. The 41+ blobs across 5 tests are mostly side-thread
overhead (titles, summaries, introspection), not direct task content.
TT tooling needs to filter this for usability.

## Design recommendations from the test campaign

1. **Capture `tools` / `tool_choice`** on the blob — addressed in
   commit 509a670 (post-Test 4). A TT can now see what tools were
   advertised, not only which were invoked.

2. **Surface the "thread fingerprint"** in the TT view: group blobs
   by `messages[0]` (system prompt) hash. Sisyphus / title-gen /
   summarizer threads cluster naturally that way.

3. **Document the per-task amplification** in admin docs:
   "expect 10-30 blobs per opencode-driven user task". If TT pays
   per-storage on jbox, this is the budgeting number.

4. **Maybe (later, optional)**: relax SessionTracker. Today it's
   strict-prefix — perfect for users hitting the API directly,
   misses N opportunities to merge with agent platforms. Could add a
   second-pass merger that links sessions sharing `messages[0]`
   hash + user-message hash within an N-minute window. This is the
   "Option B" from Test 1's findings, deferred until we have a
   real consumer asking for it.
