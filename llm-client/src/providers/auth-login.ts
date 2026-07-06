import type { FetchLike } from "../http/proxy";
import type { AuthStore, OAuthAuth } from "./auth-store";
import { extractCodexAccountId, parseTokenResponse } from "./codex";
import { fetchWithProxy, userAgent } from "./plugin";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
const COPILOT_CLIENT_ID = "Ov23li8tweQw6odWQebz";
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;

type LoginOpts = {
  authStore: AuthStore;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  notify?: (line: string) => void;
  now?: () => number;
};

function defaults(opts: LoginOpts): Required<LoginOpts> {
  return {
    fetchImpl: opts.fetchImpl ?? (fetch as unknown as FetchLike),
    sleep:
      opts.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    notify: opts.notify ?? ((line) => console.log(line)),
    now: opts.now ?? Date.now,
    authStore: opts.authStore,
  };
}

export async function loginCodexDevice(opts: LoginOpts): Promise<OAuthAuth> {
  const d = defaults(opts);
  const deviceResponse = await fetchWithProxy(
    d.fetchImpl,
    `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": userAgent(),
      },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    },
  );
  if (!deviceResponse.ok) {
    throw new Error(
      `Codex device authorization failed: ${deviceResponse.status}`,
    );
  }

  const deviceData = (await deviceResponse.json()) as {
    device_auth_id: string;
    user_code: string;
    interval: string;
    expires_in?: number | string;
  };
  const interval = Math.max(Number.parseInt(deviceData.interval) || 5, 1);
  const ttlSeconds = Number(deviceData.expires_in);
  const deadlineMs =
    (Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 900) * 1000;
  const startedAt = d.now();
  d.notify(`Open ${CODEX_ISSUER}/codex/device`);
  d.notify(`Enter code: ${deviceData.user_code}`);

  while (true) {
    if (d.now() - startedAt >= deadlineMs) {
      throw new Error(
        "Codex device authorization expired before it was approved. " +
          "Re-run `aimdware-router auth login codex`.",
      );
    }
    const response = await fetchWithProxy(
      d.fetchImpl,
      `${CODEX_ISSUER}/api/accounts/deviceauth/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": userAgent(),
        },
        body: JSON.stringify({
          device_auth_id: deviceData.device_auth_id,
          user_code: deviceData.user_code,
        }),
      },
    );

    if (response.ok) {
      const code = (await response.json()) as {
        authorization_code: string;
        code_verifier: string;
      };
      const tokenResponse = await fetchWithProxy(
        d.fetchImpl,
        `${CODEX_ISSUER}/oauth/token`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": userAgent(),
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code.authorization_code,
            redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
            client_id: CODEX_CLIENT_ID,
            code_verifier: code.code_verifier,
          }).toString(),
        },
      );
      if (!tokenResponse.ok) {
        throw new Error(`Codex token exchange failed: ${tokenResponse.status}`);
      }
      const tokens = parseTokenResponse(await tokenResponse.json());
      const auth: OAuthAuth = {
        type: "oauth",
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: d.now() + (tokens.expires_in ?? 3600) * 1000,
        account_id: extractCodexAccountId(tokens),
      };
      await d.authStore.set("codex", auth);
      return auth;
    }

    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Codex authorization polling failed: ${response.status}`);
    }
    await d.sleep(interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS);
  }
}

export async function loginCopilotDevice(
  opts: LoginOpts & { enterpriseUrl?: string },
): Promise<OAuthAuth> {
  const d = defaults(opts);
  const domain = opts.enterpriseUrl
    ? opts.enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : "github.com";
  const deviceUrl = `https://${domain}/login/device/code`;
  const tokenUrl = `https://${domain}/login/oauth/access_token`;
  const deviceResponse = await fetchWithProxy(d.fetchImpl, deviceUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": userAgent(),
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  });
  if (!deviceResponse.ok) {
    throw new Error(
      `GitHub Copilot device authorization failed: ${deviceResponse.status}`,
    );
  }

  const deviceData = (await deviceResponse.json()) as {
    verification_uri: string;
    user_code: string;
    device_code: string;
    interval: number;
  };
  d.notify(`Open ${deviceData.verification_uri}`);
  d.notify(`Enter code: ${deviceData.user_code}`);

  while (true) {
    const response = await fetchWithProxy(d.fetchImpl, tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": userAgent(),
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceData.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    if (!response.ok) {
      throw new Error(
        `GitHub Copilot token polling failed: ${response.status}`,
      );
    }

    const data = (await response.json()) as {
      access_token?: string;
      error?: string;
      interval?: number;
    };
    if (data.access_token) {
      const auth: OAuthAuth = {
        type: "oauth",
        access: data.access_token,
        refresh: data.access_token,
        expires: 0,
        ...(opts.enterpriseUrl ? { enterprise_url: domain } : {}),
      };
      await d.authStore.set("copilot", auth);
      return auth;
    }
    if (data.error && data.error !== "authorization_pending") {
      if (data.error !== "slow_down") {
        throw new Error(`GitHub Copilot authorization failed: ${data.error}`);
      }
    }
    const interval =
      data.error === "slow_down"
        ? (data.interval ?? deviceData.interval + 5)
        : deviceData.interval;
    await d.sleep(interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS);
  }
}
