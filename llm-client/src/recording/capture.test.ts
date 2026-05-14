import { test, expect } from "bun:test";
import { captureChat, tryParseJSON, decodeBytes } from "./capture";

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

test("captureChat: non-streaming — clientResponse byte-exact, captured request + response bytes returned", async () => {
  const requestText =
    '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}';
  const responseText = '{"id":"x","choices":[{"message":{"content":"hello"}}]}';

  const upstreamRes = new Response(responseText, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const { clientResponse, captureP } = captureChat(
    enc(requestText),
    upstreamRes,
  );

  expect(await clientResponse.text()).toBe(responseText);

  const r = await captureP;
  expect(r.upstream_status).toBe(200);
  expect(dec(r.request_bytes)).toBe(requestText);
  expect(dec(r.response_bytes)).toBe(responseText);
  expect(r.record_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("captureChat: streaming — clientResponse byte-for-byte + response_bytes is the joined raw SSE", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const upstreamRes = makeStreamingResponse(chunks);
  const { clientResponse, captureP } = captureChat(enc("req"), upstreamRes);

  expect(await clientResponse.text()).toBe(chunks.join(""));

  const r = await captureP;
  expect(dec(r.response_bytes)).toBe(chunks.join(""));
});

test("captureChat: 204 / empty body — captures empty response_bytes without hanging", async () => {
  const upstreamRes = new Response(null, { status: 204 });
  const { clientResponse, captureP } = captureChat(enc("x"), upstreamRes);
  expect(clientResponse.status).toBe(204);

  const r = await captureP;
  expect(r.upstream_status).toBe(204);
  expect(r.response_bytes.byteLength).toBe(0);
});

test("captureChat: still captures full response even if client cancels mid-stream", async () => {
  const chunks = ["chunk1\n", "chunk2\n", "chunk3\n"];
  const upstreamRes = makeStreamingResponse(chunks);

  const { clientResponse, captureP } = captureChat(enc("req"), upstreamRes);
  const reader = clientResponse.body!.getReader();
  await reader.read();
  await reader.cancel("client gone");

  const r = await captureP;
  expect(dec(r.response_bytes)).toBe(chunks.join(""));
});

test("tryParseJSON: parses valid JSON / returns string for invalid", () => {
  expect(tryParseJSON('{"a":1}')).toEqual({ a: 1 });
  expect(tryParseJSON("not json")).toBe("not json");
});

test("decodeBytes: round-trips utf-8", () => {
  expect(decodeBytes(new TextEncoder().encode("héllo"))).toBe("héllo");
});
