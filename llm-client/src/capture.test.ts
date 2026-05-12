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

test("captureChat: non-streaming response — clientResponse byte-exact + blob holds request + response as parsed objects", async () => {
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
  expect(blob.request).toEqual({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(blob.response).toEqual({
    id: "chatcmpl-xyz",
    choices: [{ message: { content: "hello" } }],
  });
  expect(blob.upstream_status).toBe(200);
  expect(typeof blob.ts).toBe("string");
  expect(result.record_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // Blob is pretty-printed so it's readable in jbox / an editor.
  expect(dec(result.blob_bytes)).toContain('\n  "request":');
});

test("captureChat: streaming response — clientResponse byte-for-byte + blob has raw SSE text", async () => {
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
  // SSE isn't JSON; response stays a string so the raw stream is preserved.
  expect(blob.response).toBe(chunks.join(""));
  // Request is always a JSON object.
  expect(blob.request).toEqual({
    model: "gpt-4o",
    stream: true,
    messages: [],
  });
});

test("captureChat: blob_hash equals sha256(blob_bytes)", async () => {
  const upstreamRes = new Response("response", { status: 200 });
  const { captureP } = captureChat(enc("request"), upstreamRes);
  const result = await captureP;

  const expected = new Bun.CryptoHasher("sha256").update(result.blob_bytes).digest();
  expect(Buffer.from(result.blob_hash)).toEqual(Buffer.from(expected as Uint8Array));
  expect(result.blob_size).toBe(result.blob_bytes.byteLength);
});

test("captureChat: 204 / empty body — captures empty response without hanging", async () => {
  const upstreamRes = new Response(null, { status: 204 });
  const { clientResponse, captureP } = captureChat(enc("x"), upstreamRes);
  expect(clientResponse.status).toBe(204);

  const result = await captureP;
  const blob = JSON.parse(dec(result.blob_bytes));
  // Empty body isn't valid JSON; response stays as the empty string.
  expect(blob.response).toBe("");
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
  expect(blob.response).toBe(chunks.join(""));
});
