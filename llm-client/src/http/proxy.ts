import { getProxyForUrl } from "./net";
import { createOpenAIProvider } from "../providers/openai";
import {
  UnsupportedProviderProtocolError,
  type ProviderRuntime,
} from "../providers/plugin";

export type UpstreamConfig = {
  base_url: string;
  api_key: string;
};

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit & { proxy?: string },
) => Promise<Response>;

export type ProxyChatOpts = {
  fetchImpl?: FetchLike;
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length", // recomputed by fetch
]);

export async function proxyChat(
  inbound: Request,
  upstream: UpstreamConfig | ProviderRuntime,
  opts: ProxyChatOpts = {},
): Promise<Response> {
  return proxyPrepared(inbound, upstream, "chat", opts);
}

export async function proxyResponses(
  inbound: Request,
  upstream: UpstreamConfig | ProviderRuntime,
  opts: ProxyChatOpts = {},
): Promise<Response> {
  return proxyPrepared(inbound, upstream, "responses", opts);
}

export async function proxyMessages(
  inbound: Request,
  upstream: UpstreamConfig | ProviderRuntime,
  opts: ProxyChatOpts = {},
): Promise<Response> {
  return proxyPrepared(inbound, upstream, "messages", opts);
}

async function proxyPrepared(
  inbound: Request,
  upstream: UpstreamConfig | ProviderRuntime,
  protocol: "chat" | "responses" | "messages",
  opts: ProxyChatOpts,
): Promise<Response> {
  const inboundUrl = new URL(inbound.url);

  const forwardedHeaders = new Headers();
  inbound.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      forwardedHeaders.set(key, value);
    }
  });

  const body =
    inbound.method === "GET" || inbound.method === "HEAD"
      ? undefined
      : await inbound.arrayBuffer();
  const provider =
    "prepareChat" in upstream ? upstream : createOpenAIProvider(upstream);
  const prepare =
    protocol === "chat"
      ? provider.prepareChat
      : protocol === "responses"
        ? provider.prepareResponses
        : provider.prepareMessages;
  if (!prepare) {
    throw new UnsupportedProviderProtocolError(
      `provider ${provider.id} does not support /v1/messages`,
    );
  }
  const prepared = await prepare({
    inboundUrl,
    method: inbound.method,
    headers: forwardedHeaders,
    body,
  });

  const proxy = getProxyForUrl(prepared.url);
  const f: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);

  const init: RequestInit & { proxy?: string } = {
    method: prepared.method ?? inbound.method,
    headers: prepared.headers,
    body: body === undefined ? undefined : (prepared.body ?? body),
  };
  if (proxy !== undefined) init.proxy = proxy;

  const upstreamRes = await f(prepared.url, init);

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: upstreamRes.headers,
  });
}
