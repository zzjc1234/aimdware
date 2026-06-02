import { test, expect } from "bun:test";
import { proxyChat, proxyResponses, type FetchLike } from "../http/proxy";
import { createCodexProvider, extractCodexAccountId } from "./codex";
import { createCopilotProvider } from "./copilot";
import { userAgent } from "./plugin";
import type { AuthStore, ProviderAuth } from "./auth-store";

function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function expiredCodexStore(): AuthStore {
  return authStore({
    type: "oauth",
    access: "expired-access",
    refresh: "refresh-token",
    expires: 1,
    account_id: "acct-old",
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const responsesInput = () => ({
  inboundUrl: new URL("http://router-local/v1/responses"),
  method: "POST",
  headers: new Headers(),
  body: undefined,
});

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

function snapshotProxyEnv(): Partial<
  Record<(typeof PROXY_ENV_KEYS)[number], string>
> {
  const snapshot: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) snapshot[key] = value;
    delete process.env[key];
  }
  return snapshot;
}

function restoreProxyEnv(
  snapshot: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>>,
): void {
  for (const key of PROXY_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function authStore(initial: ProviderAuth): AuthStore {
  let value: ProviderAuth | undefined = initial;
  return {
    async get(id) {
      expect(["codex", "copilot"]).toContain(id);
      return value;
    },
    async set(_id, next) {
      value = next;
    },
    async del(_id) {
      value = undefined;
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
      headers: {
        authorization: "Bearer client-token",
        "x-api-key": "client-api-key",
      },
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
  expect(upstreamCalls[0]!.headers["x-api-key"]).toBeUndefined();
  expect(upstreamCalls[0]!.headers["chatgpt-account-id"]).toBe("acct-old");
});

test("codex provider refresh uses HTTPS_PROXY", async () => {
  const originalProxy = snapshotProxyEnv();
  process.env.HTTPS_PROXY = "http://127.0.0.1:10870";
  const store = authStore({
    type: "oauth",
    access: "expired-access",
    refresh: "refresh-token",
    expires: 1,
  });
  const refreshCalls: Array<RequestInit & { proxy?: string }> = [];

  const refreshFetch: FetchLike = async (_input, init) => {
    refreshCalls.push((init ?? {}) as RequestInit & { proxy?: string });
    return Response.json({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3600,
    });
  };
  const upstreamFetch: FetchLike = async () =>
    new Response('{"ok":true}', { status: 200 });

  try {
    await proxyResponses(
      new Request("http://router-local/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.3-codex", input: [] }),
      }),
      createCodexProvider({ authStore: store, fetchImpl: refreshFetch }),
      { fetchImpl: upstreamFetch },
    );
  } finally {
    restoreProxyEnv(originalProxy);
  }

  expect(refreshCalls[0]!.proxy).toBe("http://127.0.0.1:10870");
});

test("codex provider strips max_output_tokens before forwarding", async () => {
  const store = authStore({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 600_000,
  });
  const upstreamBodies: string[] = [];
  const upstreamFetch: FetchLike = async (_input, init) => {
    const body = init?.body;
    upstreamBodies.push(
      body instanceof ArrayBuffer
        ? new TextDecoder().decode(body)
        : String(body),
    );
    return new Response('{"ok":true}', { status: 200 });
  };

  await proxyResponses(
    new Request("http://router-local/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        input: [],
        max_output_tokens: 1024,
      }),
    }),
    createCodexProvider({ authStore: store }),
    { fetchImpl: upstreamFetch },
  );

  expect(JSON.parse(upstreamBodies[0]!)).toEqual({
    model: "gpt-5.3-codex",
    input: [],
  });
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

test("copilot provider marks agent-initiated chat requests", async () => {
  const store = authStore({
    type: "oauth",
    access: "gho-access",
    refresh: "gho-access",
    expires: 0,
  });
  const upstreamCalls: Array<{ headers: Record<string, string> }> = [];
  const upstreamFetch: FetchLike = async (_input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    upstreamCalls.push({ headers });
    return new Response('{"ok":true}', { status: 200 });
  };

  await proxyChat(
    new Request("http://router-local/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.1-codex",
        messages: [
          { role: "user", content: "start" },
          { role: "assistant", content: "working" },
        ],
      }),
    }),
    createCopilotProvider({ authStore: store }),
    { fetchImpl: upstreamFetch },
  );

  expect(upstreamCalls[0]!.headers["x-initiator"]).toBe("agent");
});

test("codex refresh is single-flight under concurrent expired requests", async () => {
  const store = expiredCodexStore();
  let refreshCalls = 0;
  const refreshFetch: FetchLike = async () => {
    refreshCalls++;
    await new Promise((r) => setTimeout(r, 5));
    return jsonResponse({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3600,
    });
  };
  const provider = createCodexProvider({
    authStore: store,
    fetchImpl: refreshFetch,
  });

  await Promise.all([
    provider.prepareResponses(responsesInput()),
    provider.prepareResponses(responsesInput()),
  ]);

  expect(refreshCalls).toBe(1);
});

test("codex refreshes when the token is within the 60s expiry skew window", async () => {
  const store = authStore({
    type: "oauth",
    access: "soon-to-expire",
    refresh: "refresh-token",
    expires: Date.now() + 30_000,
  });
  let refreshed = false;
  const refreshFetch: FetchLike = async () => {
    refreshed = true;
    return jsonResponse({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3600,
    });
  };

  await createCodexProvider({
    authStore: store,
    fetchImpl: refreshFetch,
  }).prepareResponses(responsesInput());

  expect(refreshed).toBe(true);
});

test("codex refresh sends a User-Agent header", async () => {
  const store = expiredCodexStore();
  const seen: { ua: string | null } = { ua: null };
  const refreshFetch: FetchLike = async (_input, init) => {
    seen.ua = new Headers(init?.headers).get("user-agent");
    return jsonResponse({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3600,
    });
  };

  await createCodexProvider({
    authStore: store,
    fetchImpl: refreshFetch,
  }).prepareResponses(responsesInput());

  expect(seen.ua).toBe(userAgent());
});

test("codex refresh preserves the old refresh token when the response omits one", async () => {
  const store = expiredCodexStore();
  const refreshFetch: FetchLike = async () =>
    jsonResponse({ access_token: "fresh-access", expires_in: 3600 });

  await createCodexProvider({
    authStore: store,
    fetchImpl: refreshFetch,
  }).prepareResponses(responsesInput());

  expect(await store.get("codex")).toMatchObject({
    access: "fresh-access",
    refresh: "refresh-token",
  });
});

test("codex refresh rejects a token response missing access_token without persisting", async () => {
  const store = expiredCodexStore();
  const refreshFetch: FetchLike = async () =>
    jsonResponse({ refresh_token: "fresh-refresh", expires_in: 3600 });

  await expect(
    createCodexProvider({
      authStore: store,
      fetchImpl: refreshFetch,
    }).prepareResponses(responsesInput()),
  ).rejects.toThrow(/access_token/);

  expect(await store.get("codex")).toMatchObject({ access: "expired-access" });
});

test("codex surfaces a re-login instruction and clears auth when the refresh token is rejected", async () => {
  const store = expiredCodexStore();
  const refreshFetch: FetchLike = async () =>
    jsonResponse({ error: "invalid_grant" }, 400);

  await expect(
    createCodexProvider({
      authStore: store,
      fetchImpl: refreshFetch,
    }).prepareResponses(responsesInput()),
  ).rejects.toThrow(/auth login codex/);

  expect(await store.get("codex")).toBeUndefined();
});

test("codex treats a 401 refresh as terminal re-login", async () => {
  const store = expiredCodexStore();
  const refreshFetch: FetchLike = async () =>
    new Response("nope", { status: 401 });

  await expect(
    createCodexProvider({
      authStore: store,
      fetchImpl: refreshFetch,
    }).prepareResponses(responsesInput()),
  ).rejects.toThrow(/auth login codex/);
});

test("extractCodexAccountId uses explicit chatgpt_account_id but ignores organizations fallback", () => {
  expect(
    extractCodexAccountId({
      access_token: "x",
      id_token: jwt({ chatgpt_account_id: "acct-123" }),
    }),
  ).toBe("acct-123");

  expect(
    extractCodexAccountId({
      access_token: "x",
      id_token: jwt({ organizations: [{ id: "org-999" }] }),
    }),
  ).toBeUndefined();
});
