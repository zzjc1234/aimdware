import type { AuthStore, OAuthAuth } from "./auth-store";
import {
  UnsupportedProviderProtocolError,
  type ProviderFetchOpts,
  type ProviderRuntime,
} from "./plugin";
import { userAgent } from "./plugin";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

type TokenResponse = {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
};

type JwtClaims = {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
};

export type CodexProviderOpts = ProviderFetchOpts & {
  authStore: AuthStore;
};

function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return undefined;
  }
}

function extractAccountIdFromClaims(claims: JwtClaims): string | undefined {
  return (
    claims.chatgpt_account_id ??
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
    claims.organizations?.[0]?.id
  );
}

export function extractCodexAccountId(
  tokens: TokenResponse,
): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  return undefined;
}

async function refreshAccessToken(
  refreshToken: string,
  opts: Required<ProviderFetchOpts>,
): Promise<TokenResponse> {
  const response = await opts.fetchImpl(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Codex token refresh failed: ${response.status}`);
  }
  return (await response.json()) as TokenResponse;
}

async function currentAuth(opts: CodexProviderOpts): Promise<OAuthAuth> {
  const now = opts.now ?? Date.now;
  const fetchImpl =
    opts.fetchImpl ?? (fetch as unknown as ProviderFetchOpts["fetchImpl"]);
  const auth = await opts.authStore.get("codex");
  if (!auth || auth.type !== "oauth") {
    throw new Error(
      "Codex subscription is not logged in. Run `aimdware-router auth login codex` first.",
    );
  }

  if (auth.access && auth.expires > now()) return auth;

  const tokens = await refreshAccessToken(auth.refresh, {
    now,
    fetchImpl: fetchImpl!,
  });
  const next: OAuthAuth = {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now() + (tokens.expires_in ?? 3600) * 1000,
    account_id:
      extractCodexAccountId(tokens) ?? auth.account_id ?? auth.accountId,
  };
  await opts.authStore.set("codex", next);
  return next;
}

export function createCodexProvider(opts: CodexProviderOpts): ProviderRuntime {
  const prepareResponses = async (
    input: Parameters<ProviderRuntime["prepareResponses"]>[0],
  ) => {
    const auth = await currentAuth(opts);
    const headers = new Headers(input.headers);
    headers.delete("authorization");
    headers.delete("Authorization");
    headers.set("authorization", `Bearer ${auth.access}`);
    headers.set("originator", "aimdware-router");
    headers.set("User-Agent", userAgent());
    const accountId = auth.account_id ?? auth.accountId;
    if (accountId) headers.set("ChatGPT-Account-Id", accountId);

    return {
      url: new URL(CODEX_API_ENDPOINT),
      method: input.method,
      headers,
      body: input.body,
    };
  };

  return {
    id: "codex",
    label: "ChatGPT Codex subscription",
    async prepareChat() {
      throw new UnsupportedProviderProtocolError(
        "provider codex does not support /v1/chat/completions; use /v1/responses",
      );
    },
    prepareResponses,
  };
}
