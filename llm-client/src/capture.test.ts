import { test, expect } from "bun:test";
import { captureChat } from "./capture";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function makeStreamingResponse(chunks: string[], opts: ResponseInit = {}) {
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      for (const c of chunks) {
        ctrl.enqueue(enc(c));
        await Bun.sleep(2);
      }
      ctrl.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...opts,
  });
}

test("captureChat: non-streaming response — clientResponse byte-exact + blob holds request + response", async () => {
  const requestText = '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}';
  const responseText = '{"id":"chatcmpl-xyz","choices":[{"message":{"content":"hello"}}]}';

  const upstreamRes = new Response(responseText, {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const { clientResponse, captureP } = captureChat(enc(requestText), upstreamRes);

  expect(await clientResponse.text()).toBe(responseText);

  const result = await captureP;
  const blob = JSON.parse(dec(result.blob_bytes));
  expect(blob.request_text).toBe(requestText);
  expect(blob.response_text).toBe(responseText);
  expect(blob.upstream_status).toBe(200);
  expect(typeof blob.ts).toBe("string");
  expect(result.record_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("captureChat: streaming response — clientResponse byte-for-byte + blob has concatenated SSE text", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const requestText = '{"model":"gpt-4o","stream":true,"messages":[]}';

  const upstreamRes = makeStreamingResponse(chunks);
  const { clientResponse, captureP } = captureChat(enc(requestText), upstreamRes);

  expect(await clientResponse.text()).toBe(chunks.join(""));

  const result = await captureP;
  const blob = JSON.parse(dec(result.blob_bytes));
  expect(blob.response_text).toBe(chunks.join(""));
  expect(blob.request_text).toBe(requestText);
});

test("captureChat: blob_hash equals sha256(blob_bytes)", async () => {
  const upstreamRes = new Response("response", { status: 200 });
  const { captureP } = captureChat(enc("request"), upstreamRes);
  const result = await captureP;

  const expected = new Bun.CryptoHasher("sha256").update(result.blob_bytes).digest();
  expect(Buffer.from(result.blob_hash)).toEqual(Buffer.from(expected as Uint8Array));
  expect(result.blob_size).toBe(result.blob_bytes.byteLength);
});

test("captureChat: 204 / empty body — captures empty response_text without hanging", async () => {
  const upstreamRes = new Response(null, { status: 204 });
  const { clientResponse, captureP } = captureChat(enc("x"), upstreamRes);
  expect(clientResponse.status).toBe(204);

  const result = await captureP;
  const blob = JSON.parse(dec(result.blob_bytes));
  expect(blob.response_text).toBe("");
  expect(blob.upstream_status).toBe(204);
});

test("captureChat: still captures full response even if client cancels mid-stream", async () => {
  const chunks = ["chunk1\n", "chunk2\n", "chunk3\n"];
  const upstreamRes = makeStreamingResponse(chunks);

  const { clientResponse, captureP } = captureChat(enc("req"), upstreamRes);

  // Read the first chunk then cancel
  const reader = clientResponse.body!.getReader();
  await reader.read();
  await reader.cancel("client gone");

  const result = await captureP;
  const blob = JSON.parse(dec(result.blob_bytes));
  expect(blob.response_text).toBe(chunks.join(""));
});
