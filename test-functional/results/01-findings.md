# Test 1 findings — small task via opencode

## What we asked
> Write a Python one-liner that reverses a string. Just the code, no
> explanation, no markdown fences.

Trivial task. Expected: 1 user turn → 1 jbox file → `verified: true`.

## What actually happened

**14 jbox files** for one `opencode run`. Final outcome: opencode hit
the model's 65k-token context window and crashed:

```
litellm.ContextWindowExceededError: This model's maximum context
length is 65536 tokens. However, you requested 32000 output tokens
and your prompt contains at least 33537 input tokens.
```

Categorized by system prompt:

| count | system-prompt prefix                                | what it is                |
|-------|------------------------------------------------------|---------------------------|
| 7     | `<Role> You are "Sisyphus"`                          | task-running agent (plugin) |
| 6     | `You are a helpful AI assistant tasked with summarizing conversations` | parallel summarizer |
| 1     | `You are a title generator`                          | thread-title generator    |

Plus my own `curl` sanity probe (1 file) ⇒ 15 total. The router
captured all of them correctly.

## Why all 7 Sisyphus turns are SEPARATE sessions

Our `SessionTracker.classify` requires the next request's `messages`
array to be a **strict prefix-extension** of the prior tip. Looking at
the Sisyphus blob message counts across time:

```
t1: 2 msgs (system + user)
t2: 7 msgs
t3: 4 msgs  ← shrank!
t4: 7 msgs
t5: 4 msgs
t6: 4 msgs
t7: 4 msgs
```

The messages array **shrinks** between turns. That's not extension —
it's rewriting/compression done by the oh-my-opencode "Sisyphus"
agent runtime. Each non-extending turn → new `session_id` → new jbox
file.

The 6 summarizer calls are independent for the same reason: each
summarizes a DIFFERENT slice of the agent's history, so they don't
share prefixes either.

## What this says about the design

**SessionTracker's strict-prefix assumption is too tight for real agent
platforms that do internal compression.** When the agent runtime
silently shortens history between turns, every turn looks like a new
conversation.

Two options:

**A) Accept it.** Document that with opencode-style agents, "one user
ask" produces N jbox files. TT correlates by `course_id` + `user_id` +
`ts` window, not by `session_id` alone. Storage stays O(per-turn)
which is what we tried to avoid with Design A.

**B) Loosen SessionTracker.** Identify sessions by something more
stable than strict-prefix:
   - hash of first user message + first system message → same session
   - Or accept a `session_id` HTTP header from the client, fall back to
     prefix detection if not present
   - Or treat compression-induced shrinkage as continuation if the
     first-user-message stable hash matches

Option B is the right long-term answer if we expect agents to be the
primary use case. Option A is fine for human chat.

## Other observations

- **Plugin amplification**: my user's opencode has `oh-my-opencode`
  plugins installed (`opencode-gemini-auth`, `oh-my-opencode`,
  `@tarquinen/opencode-dcp`, `opencode-md-table-formatter`,
  `opencode-pty`). Sisyphus comes from oh-my-opencode. A bare
  `opencode run` might be substantially cleaner. **TODO: re-run
  without plugins for a baseline.**
- **Rate-limit pressure**: 15 calls for one trivial ask × 10 req/min
  cap = ~90 sec of agent loop already at the bound. Multi-turn agent
  conversations against SJTU will get throttled.
- **Failure mode is upstream-side**: when opencode's context grows past
  the model limit, the failure surfaces as an upstream 400, which the
  router faithfully records as a `latest_response: {error: {...}}`
  blob. `verified: true` against that error blob — the router itself
  is fine.

## Recommendation before continuing

Before running tests 2–5 we should:

1. **Decide on the SessionTracker question** (A vs B). If A, document
   and move on. If B, design + implement before tests 3/4/5 (which all
   involve multi-turn agent loops and would multiply the problem).
2. **Try a bare opencode** to confirm the plugin is the cause, not
   opencode itself. Run with `--config /dev/null` or similar to
   bypass `~/.config/opencode/opencode.json`'s plugin list.
3. **Add a stop-loss in the router**: when a session's blob exceeds N
   MB, log a warning. The 95KB blob we saw is well under our config
   pressure, but a real agent run with 1M-token context would blow up
   jbox uploads if unchecked.
