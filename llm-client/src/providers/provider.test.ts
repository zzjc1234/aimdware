import { test, expect } from "bun:test";
import { proxyChat, proxyResponses, type FetchLike } from "../http/proxy";
import { createCodexProvider } from "./codex";
import { createCopilotProvider } from "./copilot";
import type { AuthStore, ProviderAuth } from "./auth-store";

function authStore(initial: ProviderAuth): AuthStore {
  let value = initial;
  return {
    async get(id) {
      expect(["codex", "copilot"]).toContain(id);
      return value;
    },
    async set(_id, next) {
      value = next;
    },
  };
}

test("codex provider refreshes oauth and rewrites Responses requests to the Codex endpoint", async () => {
  const store = authStore({
    type: "oauth",
    access: "expired-access",
    refresh: "refresh-token",
    expires: 1,
    account_id: "acct-old",
  });
  const upstreamCalls: Array<{ url: string; headers: Record<string, string> }> =
    [];

  const refreshFetch: FetchLike = async () =>
    new Response(
      JSON.stringify({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const upstreamFetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    upstreamCalls.push({
      url: input instanceof URL ? input.toString() : String(input),
      headers,
    });
    return new Response('{"ok":true}', { status: 200 });
  };

  await proxyResponses(
    new Request("http://router-local/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer client-token" },
      body: JSON.stringify({ model: "gpt-5.3-codex", input: [] }),
    }),
    createCodexProvider({ authStore: store, fetchImpl: refreshFetch }),
    { fetchImpl: upstreamFetch },
  );

  expect(upstreamCalls).toHaveLength(1);
  expect(upstreamCalls[0]!.url).toBe(
    "https://chatgpt.com/backend-api/codex/responses",
  );
  expect(upstreamCalls[0]!.headers.authorization).toBe("Bearer fresh-access");
  expect(upstreamCalls[0]!.headers["chatgpt-account-id"]).toBe("acct-old");
});

test("codex provider rejects Chat Completions instead of sending the wrong protocol upstream", async () => {
  const store = authStore({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });

  await expect(
    proxyChat(
      new Request("http://router-local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.3-codex", messages: [] }),
      }),
      createCodexProvider({ authStore: store }),
    ),
  ).rejects.toThrow("does not support /v1/chat/completions");
});

test("copilot provider targets GitHub Copilot and adds subscription headers", async () => {
  const store = authStore({
    type: "oauth",
    access: "gho-access",
    refresh: "gho-access",
    expires: 0,
  });
  const upstreamCalls: Array<{ url: string; headers: Record<string, string> }> =
    [];
  const upstreamFetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    upstreamCalls.push({
      url: input instanceof URL ? input.toString() : String(input),
      headers,
    });
    return new Response('{"ok":true}', { status: 200 });
  };

  await proxyChat(
    new Request("http://router-local/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.1-codex",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image_url", image_url: { url: "data:image/png,..." } },
            ],
          },
        ],
      }),
    }),
    createCopilotProvider({ authStore: store }),
    { fetchImpl: upstreamFetch },
  );

  expect(upstreamCalls).toHaveLength(1);
  expect(upstreamCalls[0]!.url).toBe(
    "https://api.githubcopilot.com/v1/chat/completions",
  );
  expect(upstreamCalls[0]!.headers.authorization).toBe("Bearer gho-access");
  expect(upstreamCalls[0]!.headers["openai-intent"]).toBe("conversation-edits");
  expect(upstreamCalls[0]!.headers["x-initiator"]).toBe("user");
  expect(upstreamCalls[0]!.headers["copilot-vision-request"]).toBe("true");
});
