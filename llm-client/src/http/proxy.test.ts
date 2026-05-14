import { test, expect, afterEach, beforeEach } from "bun:test";
import type { Server } from "bun";
import { proxyChat, type FetchLike } from "./proxy";

beforeEach(() => {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.ALL_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.all_proxy;
  delete process.env.no_proxy;
});

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

let fakeUpstream: Server<unknown> | undefined;
const recorded: RecordedRequest[] = [];

function startFakeUpstream(
  handler: (req: Request) => Promise<Response> | Response,
): Promise<{ baseUrl: string }> {
  return new Promise((resolve) => {
    fakeUpstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = await req.text();
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        recorded.push({ url: req.url, method: req.method, headers, body });
        // Rebuild Request because we consumed the body
        const replay = new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: body || undefined,
        });
        return handler(replay);
      },
    });
    resolve({ baseUrl: `http://127.0.0.1:${fakeUpstream.port}` });
  });
}

afterEach(async () => {
  await fakeUpstream?.stop(true);
  fakeUpstream = undefined;
  recorded.length = 0;
});

test("proxyChat forwards body and rewrites Authorization to upstream's api_key", async () => {
  const { baseUrl } = await startFakeUpstream(
    () => new Response('{"id":"x"}', { headers: { "content-type": "application/json" } }),
  );

  const inbound = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer router-side-junk",
    },
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
  });

  await proxyChat(inbound, { base_url: baseUrl, api_key: "sk-upstream" });

  expect(recorded).toHaveLength(1);
  expect(recorded[0]!.url).toBe(`${baseUrl}/v1/chat/completions`);
  expect(recorded[0]!.method).toBe("POST");
  expect(recorded[0]!.headers.authorization).toBe("Bearer sk-upstream");
  const fwd = JSON.parse(recorded[0]!.body);
  expect(fwd.model).toBe("gpt-4o");
  expect(fwd.messages[0].content).toBe("hi");
});

test("proxyChat returns upstream status and body verbatim for non-stream", async () => {
  const { baseUrl } = await startFakeUpstream(
    () => new Response('{"echo":"ok"}', { status: 201, headers: { "content-type": "application/json" } }),
  );

  const res = await proxyChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    }),
    { base_url: baseUrl, api_key: "sk-x" },
  );

  expect(res.status).toBe(201);
  expect(await res.text()).toBe('{"echo":"ok"}');
});

test("proxyChat passes proxy from HTTPS_PROXY env to fetch", async () => {
  const calls: Array<{ url: string; init: RequestInit & { proxy?: string } }> = [];
  const mockFetch: FetchLike = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : (input as URL).toString(),
      init: (init ?? {}) as RequestInit & { proxy?: string },
    });
    return new Response("ok");
  };

  process.env.HTTPS_PROXY = "http://corp:8080";

  await proxyChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { base_url: "https://api.openai.com", api_key: "sk-x" },
    { fetchImpl: mockFetch },
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
  expect(calls[0]!.init.proxy).toBe("http://corp:8080");
});

test("proxyChat does not set proxy for loopback upstream", async () => {
  const calls: Array<{ init: RequestInit & { proxy?: string } }> = [];
  const mockFetch: FetchLike = async (_input, init) => {
    calls.push({ init: (init ?? {}) as RequestInit & { proxy?: string } });
    return new Response("ok");
  };

  process.env.HTTPS_PROXY = "http://corp:8080";

  await proxyChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body: "{}",
    }),
    { base_url: "http://127.0.0.1:11434", api_key: "any" },
    { fetchImpl: mockFetch },
  );

  expect(calls[0]!.init.proxy).toBeUndefined();
});

test("proxyChat relays an SSE stream chunk-by-chunk", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const { baseUrl } = await startFakeUpstream(() => {
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const enc = new TextEncoder();
        for (const c of chunks) {
          ctrl.enqueue(enc.encode(c));
          await Bun.sleep(5);
        }
        ctrl.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });

  const res = await proxyChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [], stream: true }),
    }),
    { base_url: baseUrl, api_key: "sk-x" },
  );

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const body = await res.text();
  expect(body).toBe(chunks.join(""));
});
