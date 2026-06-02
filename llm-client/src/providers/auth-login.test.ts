import { test, expect } from "bun:test";
import { loginCodexDevice, loginCopilotDevice } from "./auth-login";
import type { AuthStore, ProviderAuth } from "./auth-store";
import type { FetchLike } from "../http/proxy";

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

function memoryStore(): AuthStore & { values: Map<string, ProviderAuth> } {
  const values = new Map<string, ProviderAuth>();
  return {
    values,
    async get(id) {
      return values.get(id);
    },
    async set(id, auth) {
      values.set(id, auth);
    },
    async del(id) {
      values.delete(id);
    },
  };
}

test("loginCodexDevice stores refreshed oauth credentials", async () => {
  const store = memoryStore();
  const prompts: string[] = [];
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      return Response.json({
        device_auth_id: "device-id",
        user_code: "ABCD-EFGH",
        interval: "1",
      });
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      return Response.json({
        authorization_code: "auth-code",
        code_verifier: "verifier",
      });
    }
    return Response.json({
      access_token: "codex-access",
      refresh_token: "codex-refresh",
      expires_in: 3600,
    });
  };

  await loginCodexDevice({
    authStore: store,
    fetchImpl,
    sleep: async () => {},
    now: () => 10_000,
    notify: (line) => prompts.push(line),
  });

  expect(calls).toEqual([
    "https://auth.openai.com/api/accounts/deviceauth/usercode",
    "https://auth.openai.com/api/accounts/deviceauth/token",
    "https://auth.openai.com/oauth/token",
  ]);
  expect(prompts.join("\n")).toContain("ABCD-EFGH");
  expect(store.values.get("codex")).toMatchObject({
    type: "oauth",
    access: "codex-access",
    refresh: "codex-refresh",
    expires: 3_610_000,
  });
});

test("loginCodexDevice sends auth requests through HTTPS_PROXY", async () => {
  const originalProxy = snapshotProxyEnv();
  process.env.HTTPS_PROXY = "http://127.0.0.1:10870";
  const store = memoryStore();
  const calls: Array<RequestInit & { proxy?: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push((init ?? {}) as RequestInit & { proxy?: string });
    const url = String(input);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      return Response.json({
        device_auth_id: "device-id",
        user_code: "ABCD-EFGH",
        interval: "1",
      });
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      return Response.json({
        authorization_code: "auth-code",
        code_verifier: "verifier",
      });
    }
    return Response.json({
      access_token: "codex-access",
      refresh_token: "codex-refresh",
      expires_in: 3600,
    });
  };

  try {
    await loginCodexDevice({
      authStore: store,
      fetchImpl,
      sleep: async () => {},
      notify: () => {},
    });
  } finally {
    restoreProxyEnv(originalProxy);
  }

  expect(calls.map((call) => call.proxy)).toEqual([
    "http://127.0.0.1:10870",
    "http://127.0.0.1:10870",
    "http://127.0.0.1:10870",
  ]);
});

test("loginCopilotDevice stores GitHub Copilot oauth credentials", async () => {
  const store = memoryStore();
  const prompts: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/login/device/code")) {
      return Response.json({
        verification_uri: "https://github.com/login/device",
        user_code: "WXYZ-1234",
        device_code: "device-code",
        interval: 1,
      });
    }
    return Response.json({ access_token: "gho-token" });
  };

  await loginCopilotDevice({
    authStore: store,
    fetchImpl,
    sleep: async () => {},
    notify: (line) => prompts.push(line),
  });

  expect(prompts.join("\n")).toContain("https://github.com/login/device");
  expect(prompts.join("\n")).toContain("WXYZ-1234");
  expect(store.values.get("copilot")).toEqual({
    type: "oauth",
    access: "gho-token",
    refresh: "gho-token",
    expires: 0,
  });
});

test("loginCopilotDevice sends auth requests through HTTPS_PROXY", async () => {
  const originalProxy = snapshotProxyEnv();
  process.env.HTTPS_PROXY = "http://127.0.0.1:10870";
  const store = memoryStore();
  const calls: Array<RequestInit & { proxy?: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push((init ?? {}) as RequestInit & { proxy?: string });
    const url = String(input);
    if (url.endsWith("/login/device/code")) {
      return Response.json({
        verification_uri: "https://github.com/login/device",
        user_code: "WXYZ-1234",
        device_code: "device-code",
        interval: 1,
      });
    }
    return Response.json({ access_token: "gho-token" });
  };

  try {
    await loginCopilotDevice({
      authStore: store,
      fetchImpl,
      sleep: async () => {},
      notify: () => {},
    });
  } finally {
    restoreProxyEnv(originalProxy);
  }

  expect(calls.map((call) => call.proxy)).toEqual([
    "http://127.0.0.1:10870",
    "http://127.0.0.1:10870",
  ]);
});
