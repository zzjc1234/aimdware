import type { FetchLike } from "../http/proxy";
import { getProxyForUrl } from "../http/net";

export type ProviderId = "openai" | "codex" | "anthropic";

export type ProviderPrepareInput = {
  inboundUrl: URL;
  method: string;
  headers: Headers;
  body: ArrayBuffer | undefined;
};

export type ProviderPreparedRequest = {
  url: URL;
  method?: string;
  headers: Headers;
  body?: RequestInit["body"] | null;
};

export type ProviderRuntime = {
  id: ProviderId;
  label: string;
  prepareChat(input: ProviderPrepareInput): Promise<ProviderPreparedRequest>;
  prepareResponses(
    input: ProviderPrepareInput,
  ): Promise<ProviderPreparedRequest>;
  prepareMessages?(
    input: ProviderPrepareInput,
  ): Promise<ProviderPreparedRequest>;
};

export class UnsupportedProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedProviderProtocolError";
  }
}

export type ProviderFetchOpts = {
  fetchImpl?: FetchLike;
  now?: () => number;
};

export function openAICompatibleUrl(baseUrl: string, inboundUrl: URL): URL {
  const base = baseUrl.replace(/\/+$/, "");
  let path = inboundUrl.pathname;
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    path = path.slice("/v1".length);
  }
  return new URL(base + path + inboundUrl.search);
}

export function userAgent(): string {
  return `aimdware-router/${process.env.npm_package_version ?? "0.1.0"}`;
}

export function fetchWithProxy(
  fetchImpl: FetchLike,
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const target = input instanceof Request ? input.url : input;
  const proxy = getProxyForUrl(target);
  const next: RequestInit & { proxy?: string } = { ...init };
  if (proxy !== undefined) next.proxy = proxy;
  return fetchImpl(input, next);
}
