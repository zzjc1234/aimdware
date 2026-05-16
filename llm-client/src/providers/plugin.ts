import type { FetchLike } from "../http/proxy";

export type ProviderId = "openai" | "codex" | "copilot";

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
};

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
