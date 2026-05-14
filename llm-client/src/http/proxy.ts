import { getProxyForUrl } from "./net";

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
  upstream: UpstreamConfig,
  opts: ProxyChatOpts = {},
): Promise<Response> {
  const inboundUrl = new URL(inbound.url);
  // We can't use `new URL(absolutePath, base)` because that drops base's
  // path component. Concatenate explicitly, then dedupe a `/v1` if the
  // user put it in both `base_url` and (per OpenAI convention) we got
  // `/v1/chat/completions` inbound.
  const base = upstream.base_url.replace(/\/+$/, "");
  let path = inboundUrl.pathname;
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    path = path.slice("/v1".length);
  }
  const target = new URL(base + path + inboundUrl.search);

  const forwardedHeaders = new Headers();
  inbound.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      forwardedHeaders.set(key, value);
    }
  });
  forwardedHeaders.set("authorization", `Bearer ${upstream.api_key}`);

  const proxy = getProxyForUrl(target);
  const f: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);

  const init: RequestInit & { proxy?: string } = {
    method: inbound.method,
    headers: forwardedHeaders,
    body:
      inbound.method === "GET" || inbound.method === "HEAD"
        ? undefined
        : await inbound.arrayBuffer(),
  };
  if (proxy !== undefined) init.proxy = proxy;

  const upstreamRes = await f(target, init);

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: upstreamRes.headers,
  });
}
