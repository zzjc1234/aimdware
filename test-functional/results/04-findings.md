# Test 4 findings — agent calls MCP

## Setup
- MCP server: `@modelcontextprotocol/server-filesystem` via bunx, sandbox at
  `test-functional/mcp-sandbox/` containing exactly one file:
  `HELLO.txt` with body `the magic phrase is: PURPLE-HORSE-42`.
- opencode config (project-local):
  ```json
  "mcp": {
    "fs": {
      "type": "local",
      "command": ["bunx", "-y", "@modelcontextprotocol/server-filesystem",
                   "/Users/.../test-functional/mcp-sandbox"]
    }
  }
  ```
- Model: `aimdware/deepseek-chat`
- Prompt: ask the agent to read the only file in the MCP sandbox and
  return the magic phrase verbatim.

## What happened

**The agent never actually invoked an MCP tool.** 9 captures, zero
tool_calls, the magic phrase `PURPLE-HORSE-42` never appears in any
blob.

Why: opencode + Sisyphus + the registered MCP server collectively
inflated the system prompt past the DeepSeek 65k context window. The
captured blob's summarizer thread shows it explicitly:

```
[3] user: "The previous request exceeded the provider's size limit
          due to large media attachments. The conversation was
          compacted and media files were removed from context. ..."
```

(opencode mis-labels the cause as "media attachments" — there were
none. The real culprit is the system-prompt explosion from registering
all opencode plugins + MCP tool schemas.)

The agent then looped on summarize → "what did we do so far?" →
context-overflow → compact → repeat, until we killed it at 9
captures.

## What this exposes in our router

A real router-side concern came up that's worth fixing:

**Router does NOT capture the request's `tools` array** — only
`messages`. The OpenAI chat-completion request shape is:

```json
{
  "model": "...",
  "messages": [ ... ],
  "tools": [                   ← we throw this away
    { "type": "function",
      "function": { "name": "fs_read_file", "parameters": {...} } },
    ...
  ],
  "tool_choice": "..."         ← also thrown away
}
```

So a TT can see WHEN an agent used a tool (the assistant message has
`tool_calls`) but cannot see WHAT tools were available to it. That's
fixable: extend `buildSessionBlob` to also persist `tools` /
`tool_choice` / any other top-level chat-completion fields.

## What this exposes in opencode

- opencode's "skill" plugin and "MCP server" plugin both contribute to
  the system prompt. With oh-my-opencode + several plugins + 1 MCP
  server, just the boilerplate easily fills 30-40k tokens before any
  user content.
- The 65k DeepSeek-chat ceiling is therefore very easy to bust for
  any non-trivial task.
- opencode's response is to "compact" — but the compact also re-runs
  the model on the SAME bloated system prompt, so the next call also
  overflows. We saw this loop in real time.

## TT-relevant implications

1. **MCP-based attacks/leaks would be detectable IF the agent succeeded**
   — `tool_calls` and tool results land in `messages` and get captured.
   But context-window failures suppress execution entirely; we'd
   see the intent (in `messages[1].content` user prompt) but never the
   execution.

2. **A determined student CAN use MCP** via a direct curl or via a
   leaner client (raw OpenAI SDK + their own MCP loop). The blob would
   then carry the tool_calls and tool_responses cleanly.

3. **What the router captures is correct** — the failure is purely
   on opencode's side. Same as Test 2: capture works, the client
   doesn't reach the multimodal/MCP path because its own
   orchestration mishandles it.

## Suggested follow-up

- **Patch `buildSessionBlob` to also persist `tools` and `tool_choice`**
  — small, useful for audit completeness.
- **Document opencode's context-overflow loop** as a known agent
  pathology for students who pick DeepSeek-chat. Recommend
  `deepseek-reasoner` (128k) or `qwen` (likely larger) for any
  agent / MCP workload.

## Total captures so far across all tests

- Test 1: 17 blobs (Sisyphus + summarizers, context overflow)
- Test 2: 2 blobs (image stripped by opencode Read tool)
- Test 3: 13 blobs (skill description in system prompt; never loaded)
- Test 4: 9 blobs (MCP registered; never invoked due to context overflow)

≈ 41 captures total. Router validated end-to-end on every one
(`verified=true`).
