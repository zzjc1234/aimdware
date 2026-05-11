import { captureChat, type CaptureResult } from "./capture";
import { proxyChat, type FetchLike, type UpstreamConfig } from "./proxy";

export type HandlerOpts = {
  upstream: UpstreamConfig;
  onCapture?: (result: CaptureResult) => void;
  fetchImpl?: FetchLike;
};

export type RequestHandler = (req: Request) => Promise<Response>;

export function createHandler(opts: HandlerOpts): RequestHandler {
  return async (req) => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return handleChat(req, opts);
    }

    return new Response("not found", { status: 404 });
  };
}

async function handleChat(req: Request, opts: HandlerOpts): Promise<Response> {
  const requestBytes = new Uint8Array(await req.arrayBuffer());

  // proxyChat reads from a Request; rebuild one carrying the body we just
  // captured so capture and proxy each have their own bytes.
  const proxyReq = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: requestBytes,
  });

  const upstreamRes = await proxyChat(proxyReq, opts.upstream, {
    fetchImpl: opts.fetchImpl,
  });

  const { clientResponse, captureP } = captureChat(requestBytes, upstreamRes);

  captureP.then(
    (result) => {
      opts.onCapture?.(result);
    },
    (err) => {
      console.error("capture failed:", err);
    },
  );

  return clientResponse;
}
