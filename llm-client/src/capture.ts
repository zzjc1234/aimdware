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
  const response_text = decodeBytes(concatChunks(args.responseChunks));
  const request_text = decodeBytes(args.requestBytes);
  // Field order is deliberate: changing it changes the hash, so it's
  // pinned via the literal here. JSON.stringify preserves insertion
  // order for plain objects in V8/JSC/Bun.
  const blob = {
    record_id: args.record_id,
    ts: args.ts.toISOString(),
    upstream_status: args.upstream_status,
    request_text,
    response_text,
  };
  const blob_bytes = new TextEncoder().encode(JSON.stringify(blob));
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
