# Anthropic Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove GitHub Copilot and add `plugin: anthropic` with local `POST /v1/messages` support.

**Architecture:** The config selects one provider per router process. The provider runtime gets an optional Messages capability; only Anthropic implements it. The existing proxy and capture flow continues to move raw request/response bytes.

**Tech Stack:** Bun, TypeScript, Zod, `bun:test`.

## Global Constraints

- Valid plugins are `openai`, `codex`, and `anthropic`.
- Anthropic requires `api_key`, defaults to `https://api.anthropic.com`, and preserves Messages bytes.
- Set `anthropic-version: 2023-06-01` only when the client did not send one.
- Remove every GitHub Copilot source, test, command, configuration, and doc reference.

---

### Task 1: Remove Copilot

**Files:**
- Delete: `llm-client/src/providers/copilot.ts`
- Modify: `llm-client/src/providers/plugin.ts`, `llm-client/src/providers/index.ts`, `llm-client/src/providers/auth-login.ts`, `llm-client/src/main.ts`
- Test: `llm-client/src/providers/provider.test.ts`, `llm-client/src/providers/auth-login.test.ts`, `llm-client/src/providers/auth-store.test.ts`

**Interfaces:** `ProviderId` becomes `"openai" | "codex" | "anthropic"`; only Codex has OAuth commands.

- [ ] **Step 1: Remove Copilot-specific tests and replace multi-provider auth-store fixtures with Codex-only fixtures.**
- [ ] **Step 2: Run `bun test src/providers/provider.test.ts src/providers/auth-login.test.ts src/providers/auth-store.test.ts`; expect a missing Copilot production-symbol failure.**
- [ ] **Step 3: Delete `copilot.ts` and remove Copilot imports, OAuth login, status output, CLI help, config/factory selection, and provider ID.**
- [ ] **Step 4: Re-run the same test command; expect PASS.**
- [ ] **Step 5: Commit only these files with `git commit -m "refactor: remove Copilot provider"`.**

### Task 2: Add the Anthropic plugin

**Files:**
- Create: `llm-client/src/providers/anthropic.ts`
- Modify: `llm-client/src/config.ts`, `llm-client/src/providers/plugin.ts`, `llm-client/src/providers/index.ts`
- Test: `llm-client/src/config.test.ts`, `llm-client/src/providers/provider.test.ts`

**Interfaces:** `createAnthropicProvider({ base_url, api_key })` returns a `ProviderRuntime` with `prepareMessages`.

- [ ] **Step 1: Add failing config/provider tests. They must assert `plugin: anthropic` is accepted, keyless config fails, the default URL is `https://api.anthropic.com/v1/messages`, inbound `authorization`/`x-api-key` are removed, configured key becomes `x-api-key`, and version defaults/preserves client input.**
- [ ] **Step 2: Run `bun test src/config.test.ts src/providers/provider.test.ts`; expect failure because Anthropic is not registered.**
- [ ] **Step 3: Add `anthropic` to config/provider unions, default its base URL, require its key, select it in the factory, and create its minimal header/URL provider.**

```ts
headers.delete("authorization");
headers.delete("x-api-key");
headers.set("x-api-key", config.api_key);
if (!headers.has("anthropic-version")) {
  headers.set("anthropic-version", "2023-06-01");
}
```

- [ ] **Step 4: Re-run the focused tests; expect PASS.**
- [ ] **Step 5: Commit only Task 2 files with `git commit -m "feat: add Anthropic provider"`.**

### Task 3: Route, audit, and document Messages

**Files:**
- Modify: `llm-client/src/http/proxy.ts`, `llm-client/src/http/handler.ts`, `llm-client/src/http/proxy.test.ts`, `llm-client/src/http/handler.test.ts`
- Modify: `README.md`, `llm-client/aimdware.example.yaml`, `wiki/llm-client.md`, `wiki/architecture.md`, `wiki/student-setup.md`, `wiki/student-deployment-zh.md`

**Interfaces:** `proxyMessages(inbound, upstream, opts)` dispatches `prepareMessages`; `POST /v1/messages` is captured like other requests.

- [ ] **Step 1: Add failing HTTP tests for Messages URL/header/body forwarding, byte-exact SSE/capture behavior, and a 400 from a provider without `prepareMessages`.**
- [ ] **Step 2: Run `bun test src/http/proxy.test.ts src/http/handler.test.ts`; expect failure because the endpoint is not routed.**
- [ ] **Step 3: Implement `proxyMessages`, the optional provider capability, and handler routing/capture. A missing capability throws `UnsupportedProviderProtocolError("provider <id> does not support /v1/messages")`.**
- [ ] **Step 4: Re-run the focused HTTP tests; expect PASS.**
- [ ] **Step 5: Replace all documentation and example mentions of Copilot with Anthropic details, including:**

```yaml
upstream:
  plugin: anthropic
  base_url: https://api.anthropic.com
  api_key: sk-ant-REPLACE_ME
```

- [ ] **Step 6: Run `! rg -n -i 'copilot' README.md wiki llm-client` and `rg -n 'plugin: anthropic|/v1/messages' README.md wiki llm-client/aimdware.example.yaml`; expect no Copilot output and Anthropic docs listed.**
- [ ] **Step 7: Run `bun run format:check && bun run typecheck && bun test`; expect all commands to exit 0. Commit all Task 3 files with `git commit -m "feat: route Anthropic Messages requests"`.**
