import type { AuthStore, OAuthAuth } from "./auth-store";
import {
  UnsupportedProviderProtocolError,
  type ProviderFetchOpts,
  type ProviderRuntime,
} from "./plugin";
import { fetchWithProxy, userAgent } from "./plugin";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

// Refresh slightly before the server-side expiry so a request that starts just
// before the boundary doesn't lose a race with upstream and 401.
const EXPIRY_SKEW_MS = 60_000;

const REAUTH_HINT =
  "Run `aimdware-router auth login codex` to re-authenticate.";

type TokenResponse = {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
};

type JwtClaims = {
  chatgpt_account_id?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
};

/**
 * Thrown when the stored refresh token is no longer accepted by OpenAI
 * (revoked, expired, password change). The only remedy is an interactive
 * re-login, so the message always points there and the caller clears the
 * stale credential.
 */
export class CodexReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexReauthRequiredError";
  }
}

export type ParsedTokenResponse = {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
};

/**
 * Validate a raw OAuth token payload before it is trusted/persisted.
 *
 * Refresh responses may legitimately omit `refresh_token`; pass the previous
 * one so it is preserved rather than dropped. Login responses must include it,
 * so callers there omit `previousRefresh` and a missing token is an error.
 */
export function parseTokenResponse(
  raw: unknown,
  previousRefresh?: string,
): ParsedTokenResponse {
  if (!raw || typeof raw !== "object") {
    throw new Error("Codex token response was not a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const access = obj.access_token;
  if (typeof access !== "string" || access.length === 0) {
    throw new Error("Codex token response is missing access_token");
  }

  const refreshRaw = obj.refresh_token;
  let refresh: string;
  if (typeof refreshRaw === "string" && refreshRaw.length > 0) {
    refresh = refreshRaw;
  } else if (previousRefresh) {
    refresh = previousRefresh;
  } else {
    throw new Error("Codex token response is missing refresh_token");
  }

  let expires_in: number | undefined;
  if (obj.expires_in !== undefined) {
    if (
      typeof obj.expires_in !== "number" ||
      !Number.isFinite(obj.expires_in) ||
      obj.expires_in <= 0
    ) {
      throw new Error("Codex token response has an invalid expires_in");
    }
    expires_in = obj.expires_in;
  }

  return {
    id_token: typeof obj.id_token === "string" ? obj.id_token : undefined,
    access_token: access,
    refresh_token: refresh,
    expires_in,
  };
}

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
  // Only trust an explicit ChatGPT account id. The earlier `organizations[0].id`
  // fallback is a different identifier and can mislabel the `ChatGPT-Account-Id`
  // header; omitting the header is safer than sending the wrong value.
  return (
    claims.chatgpt_account_id ??
    claims["https://api.openai.com/auth"]?.chatgpt_account_id
  );
}

export function extractCodexAccountId(
  tokens: Pick<TokenResponse, "id_token" | "access_token">,
): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  return undefined;
}

function isTerminalAuthFailure(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  // A 400 is only terminal when it carries an OAuth invalid-credential error;
  // other 400s are treated as transient/unexpected.
  if (status === 400) {
    return /invalid_grant|invalid_request|invalid_client|invalid_token/.test(
      body,
    );
  }
  return false;
}

async function refreshAccessToken(
  refreshToken: string,
  opts: Required<ProviderFetchOpts>,
): Promise<ParsedTokenResponse> {
  const response = await fetchWithProxy(
    opts.fetchImpl,
    `${ISSUER}/oauth/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent(),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (isTerminalAuthFailure(response.status, detail)) {
      throw new CodexReauthRequiredError(
        `Codex subscription token is no longer valid (refresh rejected: ${response.status}). ${REAUTH_HINT}`,
      );
    }
    throw new Error(`Codex token refresh failed: ${response.status}`);
  }
  return parseTokenResponse(await response.json(), refreshToken);
}

type RefreshGate = { inFlight: Promise<OAuthAuth> | null };

async function currentAuth(
  opts: CodexProviderOpts,
  gate: RefreshGate,
): Promise<OAuthAuth> {
  const now = opts.now ?? Date.now;
  const fetchImpl =
    opts.fetchImpl ?? (fetch as unknown as ProviderFetchOpts["fetchImpl"]);
  const readAuth = async (): Promise<OAuthAuth> => {
    const auth = await opts.authStore.get("codex");
    if (!auth || auth.type !== "oauth") {
      throw new Error(`Codex subscription is not logged in. ${REAUTH_HINT}`);
    }
    return auth;
  };
  const isFresh = (auth: OAuthAuth): boolean =>
    Boolean(auth.access) && auth.expires > now() + EXPIRY_SKEW_MS;

  const cached = await readAuth();
  if (isFresh(cached)) return cached;

  // Single-flight: concurrent expired requests share one refresh, so a rotated
  // refresh token is fetched and persisted exactly once. The gated body
  // re-reads the store first — a request that arrives just after another
  // refresh completed must pick up the rotated token rather than refresh again
  // with the now-invalid one.
  if (gate.inFlight) return gate.inFlight;
  gate.inFlight = (async () => {
    let usedRefresh = "";
    try {
      const auth = await readAuth();
      if (isFresh(auth)) return auth;
      usedRefresh = auth.refresh;
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
    } catch (e) {
      if (e instanceof CodexReauthRequiredError) {
        // Another router process (sharing this cache) may have rotated the
        // token between our read and our failed refresh — single-use refresh
        // tokens mean the loser of a concurrent refresh gets invalid_grant.
        // If the stored token has since changed, adopt the fresh one rather
        // than deleting the credential everyone is now using.
        const latest = await opts.authStore.get("codex");
        if (
          latest?.type === "oauth" &&
          latest.refresh !== usedRefresh &&
          isFresh(latest)
        ) {
          return latest;
        }
        // The stored token is still the one we failed with: a genuine
        // revocation. Drop it so `auth status` reflects reality.
        if (
          !latest ||
          latest.type !== "oauth" ||
          latest.refresh === usedRefresh
        ) {
          await opts.authStore.del("codex");
        }
      }
      throw e;
    } finally {
      gate.inFlight = null;
    }
  })();
  return gate.inFlight;
}

function codexRequestBody(body: ArrayBuffer | undefined): RequestInit["body"] {
  if (!body) return body;
  const text = new TextDecoder().decode(body);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      delete (parsed as { max_output_tokens?: unknown }).max_output_tokens;
      return JSON.stringify(parsed);
    }
  } catch {
    // Forward non-JSON bodies unchanged so upstream produces the protocol error.
  }
  return body;
}

export function createCodexProvider(opts: CodexProviderOpts): ProviderRuntime {
  const gate: RefreshGate = { inFlight: null };

  const prepareResponses = async (
    input: Parameters<ProviderRuntime["prepareResponses"]>[0],
  ) => {
    const auth = await currentAuth(opts, gate);
    const headers = new Headers(input.headers);
    headers.delete("authorization");
    headers.delete("Authorization");
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${auth.access}`);
    headers.set("originator", "aimdware-router");
    headers.set("User-Agent", userAgent());
    const accountId = auth.account_id ?? auth.accountId;
    if (accountId) headers.set("ChatGPT-Account-Id", accountId);

    return {
      url: new URL(CODEX_API_ENDPOINT),
      method: input.method,
      headers,
      body: codexRequestBody(input.body),
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
