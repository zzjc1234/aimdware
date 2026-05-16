import { test, expect } from "bun:test";
import { loginCodexDevice, loginCopilotDevice } from "./auth-login";
import type { AuthStore, ProviderAuth } from "./auth-store";
import type { FetchLike } from "../http/proxy";

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
