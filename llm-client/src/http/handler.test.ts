import { test, expect, afterEach, beforeEach } from "bun:test";
import type { Server } from "bun";
import { createHandler } from "./handler";
import type { CaptureResult } from "../recording/capture";

let fakeUpstream: Server<unknown> | undefined;

afterEach(async () => {
  await fakeUpstream?.stop(true);
  fakeUpstream = undefined;
});

beforeEach(() => {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.ALL_PROXY;
  delete process.env.NO_PROXY;
});

function startFakeUpstream(
  responder: (req: Request) => Promise<Response> | Response,
): { baseUrl: string } {
  fakeUpstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: responder,
  });
  return { baseUrl: `http://127.0.0.1:${fakeUpstream.port}` };
}

test("GET /healthz returns 200 ok", async () => {
  const handler = createHandler({
    upstream: { base_url: "https://unused", api_key: "x" },
  });
  const res = await handler(new Request("http://localhost/healthz"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("unknown path returns 404", async () => {
  const handler = createHandler({
    upstream: { base_url: "https://unused", api_key: "x" },
  });
  const res = await handler(new Request("http://localhost/nope"));
  expect(res.status).toBe(404);
});

test("POST /v1/chat/completions forwards request to upstream", async () => {
  const seen: { body: string; auth: string | null } = { body: "", auth: null };
  const { baseUrl } = startFakeUpstream(async (req) => {
    seen.body = await req.text();
    seen.auth = req.headers.get("authorization");
    return new Response('{"id":"x"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const handler = createHandler({
    upstream: { base_url: baseUrl, api_key: "sk-upstream" },
  });

  const res = await handler(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}',
    }),
  );

  expect(res.status).toBe(200);
  expect(await res.text()).toBe('{"id":"x"}');
  const parsedBody = JSON.parse(seen.body);
  expect(parsedBody.model).toBe("gpt-4o");
  expect(seen.auth).toBe("Bearer sk-upstream");
});

test("POST /v1/chat/completions fires onCapture in background with full blob", async () => {
  const { baseUrl } = startFakeUpstream(
    () =>
      new Response('{"id":"y","model":"gpt-4o"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );

  let captured: CaptureResult | undefined;
  const captureDone = new Promise<void>((resolve) => {
    const handler = createHandler({
      upstream: { base_url: baseUrl, api_key: "sk-x" },
      onCapture: (r) => {
        captured = r;
        resolve();
      },
    });
    void handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"gpt-4o","messages":[]}',
      }),
    );
  });
  await captureDone;

  expect(captured).toBeDefined();
  expect(captured!.upstream_status).toBe(200);
  expect(new TextDecoder().decode(captured!.request_bytes)).toContain('"model":"gpt-4o"');
  const resp = JSON.parse(new TextDecoder().decode(captured!.response_bytes));
  expect(resp).toEqual({ id: "y", model: "gpt-4o" });
});

test("/v1/chat/completions streams response while still capturing", async () => {
  const chunks = ["data: a\n\n", "data: b\n\n", "data: [DONE]\n\n"];
  const { baseUrl } = startFakeUpstream(() => {
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const enc = new TextEncoder();
        for (const c of chunks) {
          ctrl.enqueue(enc.encode(c));
          await Bun.sleep(2);
        }
        ctrl.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });

  let captured: CaptureResult | undefined;
  const handler = createHandler({
    upstream: { base_url: baseUrl, api_key: "sk-x" },
    onCapture: (r) => {
      captured = r;
    },
  });

  const res = await handler(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-4o","stream":true,"messages":[]}',
    }),
  );

  expect(await res.text()).toBe(chunks.join(""));

  // capture happens after the stream completes — give the microtask a beat
  await Bun.sleep(10);
  expect(captured).toBeDefined();
  expect(new TextDecoder().decode(captured!.response_bytes)).toBe(chunks.join(""));
});
