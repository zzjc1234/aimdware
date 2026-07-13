import { captureChat, type CaptureResult } from "../recording/capture";
import {
  proxyChat,
  proxyMessages,
  proxyResponses,
  type FetchLike,
  type UpstreamConfig,
} from "./proxy";
import {
  UnsupportedProviderProtocolError,
  type ProviderRuntime,
} from "../providers/plugin";

export type HandlerOpts = {
  upstream: UpstreamConfig | ProviderRuntime;
  onCapture?: (result: CaptureResult) => void | Promise<void>;
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
      return handleProviderErrors(() => handleChat(req, opts));
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      return handleProviderErrors(() => handleResponses(req, opts));
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      return handleProviderErrors(() => handleMessages(req, opts));
    }

    return new Response("not found", { status: 404 });
  };
}

async function handleProviderErrors(
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UnsupportedProviderProtocolError) {
      return new Response(e.message, { status: 400 });
    }
    throw e;
  }
}

async function handleChat(req: Request, opts: HandlerOpts): Promise<Response> {
  return handleCaptured(req, opts, (proxyReq) =>
    proxyChat(proxyReq, opts.upstream, {
      fetchImpl: opts.fetchImpl,
    }),
  );
}

async function handleResponses(
  req: Request,
  opts: HandlerOpts,
): Promise<Response> {
  return handleCaptured(req, opts, (proxyReq) =>
    proxyResponses(proxyReq, opts.upstream, {
      fetchImpl: opts.fetchImpl,
    }),
  );
}

async function handleMessages(
  req: Request,
  opts: HandlerOpts,
): Promise<Response> {
  return handleCaptured(req, opts, (proxyReq) =>
    proxyMessages(proxyReq, opts.upstream, {
      fetchImpl: opts.fetchImpl,
    }),
  );
}

async function handleCaptured(
  req: Request,
  opts: HandlerOpts,
  proxy: (req: Request) => Promise<Response>,
): Promise<Response> {
  const requestBytes = new Uint8Array(await req.arrayBuffer());

  // The proxy reads from a Request; rebuild one carrying the body we just
  // captured so capture and proxy each have their own bytes.
  const proxyReq = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: requestBytes,
  });

  const upstreamRes = await proxy(proxyReq);

  const { clientResponse, captureP } = captureChat(requestBytes, upstreamRes);

  captureP.then(
    async (result) => {
      // onCapture is the integration point that writes to the local
      // outbox + cache. If anything in there throws (sqlite locked, disk
      // full, queue.db corrupt), we MUST log it — otherwise the record
      // silently disappears from the audit trail (client already saw
      // the response and is happy).
      try {
        await opts.onCapture?.(result);
      } catch (err) {
        console.error("onCapture failed:", err);
      }
    },
    (err) => {
      console.error("capture failed:", err);
    },
  );

  return clientResponse;
}
