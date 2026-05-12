export type CaptureResult = {
  record_id: string;
  ts: Date;
  blob_bytes: Uint8Array;
  blob_hash: Uint8Array;
  blob_size: number;
};

export function captureChat(
  requestBytes: Uint8Array,
  upstreamRes: Response,
): { clientResponse: Response; captureP: Promise<CaptureResult> } {
  const ts = new Date();
  const record_id = crypto.randomUUID();
  const upstream_status = upstreamRes.status;

  if (!upstreamRes.body) {
    const captureP = Promise.resolve(
      buildResult({
        record_id,
        ts,
        requestBytes,
        responseChunks: [],
        upstream_status,
      }),
    );
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
    return buildResult({
      record_id,
      ts,
      requestBytes,
      responseChunks: chunks,
      upstream_status,
    });
  })();

  return { clientResponse, captureP };
}

function buildResult(args: {
  record_id: string;
  ts: Date;
  requestBytes: Uint8Array;
  responseChunks: Uint8Array[];
  upstream_status: number;
}): CaptureResult {
  const responseText = decodeBytes(concatChunks(args.responseChunks));
  const requestText = decodeBytes(args.requestBytes);

  // Parse JSON when possible so the on-disk blob is directly human-readable
  // (no nested-JSON-string escaping). Streaming responses fall back to the
  // raw SSE text. Request is always JSON for OpenAI Chat Completions, but
  // we still tryParse defensively.
  const blob = {
    record_id: args.record_id,
    ts: args.ts.toISOString(),
    upstream_status: args.upstream_status,
    request: tryParseJSON(requestText),
    response: tryParseJSON(responseText),
  };

  // Pretty-print so opening the file in jbox / a text editor reads cleanly.
  // The hash binds to this exact byte representation (key order + indent).
  const blob_bytes = new TextEncoder().encode(JSON.stringify(blob, null, 2));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(blob_bytes);
  const blob_hash = hasher.digest() as Uint8Array;
  return {
    record_id: args.record_id,
    ts: args.ts,
    blob_bytes,
    blob_hash,
    blob_size: blob_bytes.byteLength,
  };
}

/**
 * Parse `s` as JSON if it is valid JSON; otherwise return the original
 * string. Used so the captured blob holds structured request/response
 * objects when possible (instead of opaque escaped strings).
 */
function tryParseJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function decodeBytes(bytes: Uint8Array): string {
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
