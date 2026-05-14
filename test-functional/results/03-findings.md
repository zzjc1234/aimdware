# Test 3 findings — agent invokes a skill

## Setup
- skill: `test-functional/skills/string-tools/SKILL.md` with frontmatter
  `name: string-tools`, `description: ... Load when ... reverse a string OR count consonants ...`
- opencode config: `"skills": { "paths": ["./skills"] }`
- prompt: "Use the string-tools skill to reverse 'elephant', then count
  unique consonants in the reversed result."
- model: `aimdware/deepseek-chat`

## How opencode's skill mechanism actually works

We discovered (by reading captured blobs) that opencode injects skill
**metadata** into the system prompt as XML:

```xml
<skill>
  <name>string-tools</name>
  <description>Reverse strings and count unique consonants. Load when the
    user explicitly asks to reverse a string OR count consonants...</description>
  <location>file:///.../skills/string-tools/SKILL.md</location>
</skill>
```

Multiple `<skill>` blocks per skill discovered (also saw `taskbook-fill`
from oh-my-opencode's bundled skills). The system prompt instructs the
agent:

> "For EVERY skill listed above, ask yourself:
> 'Does this skill's expertise domain overlap with my task?'"

When the agent decides yes, it calls a `skill` tool to load the
SKILL.md body into the conversation.

## What happened in our test

13 router captures over ~2 minutes. The agent:

- ✓ saw the skill listing in its system prompt (every Sisyphus blob
  contains the `<skill>string-tools</skill>` block)
- ✗ **never invoked the `skill` tool** — zero blobs with a tool_call
  for `skill`
- ✗ never loaded `count_unique_consonants` content — zero blobs
  contain the SKILL.md body

The agent inferred the procedures from the **description alone** and
computed the answer directly. That's reasonable for a trivial task.

## Captured-blob inventory

| count | thread                                | role |
|------:|---------------------------------------|------|
| 1     | title generator (5KB)                 | side |
| 1     | Sisyphus main (43KB, sees user task)  | main |
| 1     | Sisyphus answering with computed reply| main |
| 10    | summarizer / introspection threads    | side |

Same per-task amplification as Test 1: 13 blobs for one user request.
**Crucial**: the user task itself is reconstructible from the Sisyphus
main blob; the 10 summarizers are agent-runtime overhead.

## Router behavior: correct

Every blob:
- captured the full system prompt including `<skill>` listings
- preserved any tool_calls / tool messages (none in this run, but
  the data path is there — Test 4 will exercise this)
- `verified: true` on every record

## TT-relevant signal

**To detect whether a student's agent loaded a specific skill**:
look at any captured blob and find:

```jq
.messages[]
  | select(.role == "assistant")
  | (.tool_calls // [])[]
  | select(.function.name == "skill")
  | .function.arguments
```

If present → the skill was loaded into the conversation; the
NEXT message (role=tool) contains the SKILL.md content the model saw.

**To detect what skills were *advertised*** (whether loaded or not):
look at `.messages[0].content` (system prompt) for `<skill><name>`.

These are two distinct audit questions. Both answerable from the
captured blob.

## To extend

For a task where the agent DOES invoke `skill`: pick a domain where
the SKILL.md content is non-trivial and the description alone isn't
sufficient. Maybe a SKILL with cryptographic procedures, or one with
a precise multi-step algorithm. The description is the gate; make it
intentionally vague ("Load when needed for cryptography") to force
the agent to load.
