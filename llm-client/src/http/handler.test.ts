import { test, expect, afterEach, beforeEach } from "bun:test";
import type { Server } from "bun";
import { createHandler } from "./handler";
import type { CaptureResult } from "../recording/capture";
import { createCodexProvider } from "../providers/codex";
import type { AuthStore } from "../providers/auth-store";

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

const loggedInCodexStore: AuthStore = {
  async get() {
    return {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    };
  },
  async set() {},
  async del() {},
};

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

test("POST /v1/responses forwards Responses API request to upstream", async () => {
  const seen: { body: string; auth: string | null } = { body: "", auth: null };
  const { baseUrl } = startFakeUpstream(async (req) => {
    seen.body = await req.text();
    seen.auth = req.headers.get("authorization");
    return new Response('{"id":"resp_x"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const handler = createHandler({
    upstream: { base_url: baseUrl, api_key: "sk-upstream" },
  });

  const res = await handler(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-5","input":[{"role":"user","content":"hi"}]}',
    }),
  );

  expect(res.status).toBe(200);
  expect(await res.text()).toBe('{"id":"resp_x"}');
  expect(JSON.parse(seen.body).input[0].content).toBe("hi");
  expect(seen.auth).toBe("Bearer sk-upstream");
});

test("POST /v1/chat/completions returns 400 for Responses-only providers", async () => {
  const handler = createHandler({
    upstream: createCodexProvider({ authStore: loggedInCodexStore }),
  });

  const res = await handler(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-5.3-codex","messages":[]}',
    }),
  );

  expect(res.status).toBe(400);
  expect(await res.text()).toContain("use /v1/responses");
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
  expect(new TextDecoder().decode(captured!.request_bytes)).toContain(
    '"model":"gpt-4o"',
  );
  const resp = JSON.parse(new TextDecoder().decode(captured!.response_bytes));
  expect(resp).toEqual({ id: "y", model: "gpt-4o" });
});

test("POST /v1/responses fires onCapture in background with full blob", async () => {
  const { baseUrl } = startFakeUpstream(
    () =>
      new Response('{"id":"resp_y","model":"gpt-5"}', {
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
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"gpt-5","input":[{"role":"user","content":"hi"}]}',
      }),
    );
  });
  await captureDone;

  expect(captured).toBeDefined();
  expect(captured!.upstream_status).toBe(200);
  expect(new TextDecoder().decode(captured!.request_bytes)).toContain(
    '"input"',
  );
  const resp = JSON.parse(new TextDecoder().decode(captured!.response_bytes));
  expect(resp).toEqual({ id: "resp_y", model: "gpt-5" });
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
  expect(new TextDecoder().decode(captured!.response_bytes)).toBe(
    chunks.join(""),
  );
});

test("onCapture throwing is caught and logged, request still completes", async () => {
  const { baseUrl } = startFakeUpstream(
    () =>
      new Response('{"id":"x"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );

  const errors: string[] = [];
  const origError = console.error;
  let resolveLogged!: () => void;
  const logged = new Promise<void>((resolve) => {
    resolveLogged = resolve;
  });
  console.error = (...args) => {
    errors.push(args.join(" "));
    if (args.join(" ").includes("onCapture failed")) resolveLogged();
  };

  try {
    const handler = createHandler({
      upstream: { base_url: baseUrl, api_key: "k" },
      onCapture: async () => {
        throw new Error("simulated outbox-write failure");
      },
    });
    const res = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"gpt-4o","messages":[]}',
      }),
    );
    expect(res.status).toBe(200); // client-side success unaffected

    await Promise.race([
      logged,
      Bun.sleep(1000).then(() => {
        throw new Error("timed out waiting for onCapture error log");
      }),
    ]);
    expect(errors.join("\n")).toContain("onCapture failed");
    expect(errors.join("\n")).toContain("simulated outbox-write failure");
  } finally {
    console.error = origError;
  }
});
