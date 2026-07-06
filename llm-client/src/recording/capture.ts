/**
 * Capture a chat completion exchange: forward the upstream response to
 * the client unchanged, while accumulating the request + response bytes
 * for later session-blob assembly. The blob itself (and its hash) is
 * built downstream — capture only emits raw inputs so the caller can
 * fold them into a session-wide rollup.
 */
export type CaptureResult = {
  record_id: string;
  ts: Date;
  upstream_status: number;
  request_bytes: Uint8Array;
  response_bytes: Uint8Array;
};

export function captureChat(
  requestBytes: Uint8Array,
  upstreamRes: Response,
): { clientResponse: Response; captureP: Promise<CaptureResult> } {
  const ts = new Date();
  const record_id = crypto.randomUUID();
  const upstream_status = upstreamRes.status;

  if (!upstreamRes.body) {
    const captureP = Promise.resolve({
      record_id,
      ts,
      upstream_status,
      request_bytes: requestBytes,
      response_bytes: new Uint8Array(0),
    });
    return {
      clientResponse: new Response(null, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: upstreamRes.headers,
      }),
      captureP,
    };
  }

  const [forward, capture] = upstreamRes.body.tee();
  const clientResponse = new Response(forward, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: upstreamRes.headers,
  });

  const captureP = (async () => {
    const reader = capture.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return {
      record_id,
      ts,
      upstream_status,
      request_bytes: requestBytes,
      response_bytes: concatChunks(chunks),
    };
  })();

  return { clientResponse, captureP };
}

/**
 * Parse `s` as JSON if it is valid JSON; otherwise return the original
 * string. Used so the session blob holds structured request/response
 * objects when possible instead of opaque escaped strings.
 */
export function tryParseJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return merged;
}
