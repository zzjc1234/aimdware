import type { FetchLike } from "../http/proxy";
import type { AuthStore, OAuthAuth } from "./auth-store";
import { extractCodexAccountId, parseTokenResponse } from "./codex";
import { fetchWithProxy, userAgent } from "./plugin";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
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
