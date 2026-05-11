import { test, expect, afterEach } from "bun:test";
import type { Server } from "bun";
import { postContext, type IngestBody, type PostContextResult } from "./ingest";

let fakeBackend: Server<unknown> | undefined;
let lastReq: { body: string; auth: string | null; url: string } | undefined;

function startFakeBackend(status: number, responseBody = ""): string {
  fakeBackend = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      lastReq = {
        url: req.url,
        auth: req.headers.get("authorization"),
        body: await req.text(),
      };
      return new Response(responseBody, {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return `http://127.0.0.1:${fakeBackend.port}`;
}

afterEach(async () => {
  await fakeBackend?.stop(true);
  fakeBackend = undefined;
  lastReq = undefined;
});

function sampleBody(): IngestBody {
  return {
    record_id: "11111111-1111-1111-1111-111111111111",
    course_code: "ECE4721J",
    blob_hash: "deadbeef",
    blob_uri: "jbox://zhangsan/aimdware/ECE4721J/x.json",
    blob_size: 123,
    model: "gpt-4o-mini",
    prompt_tokens: 14,
    completion_tokens: 3,
    ts: "2026-05-11T10:00:00.000Z",
    router_version: "0.0.0",
    client_meta: { agent: "cline" },
  };
}

test("postContext sends Bearer student token + JSON body to /ingest/context", async () => {
  const url = startFakeBackend(202);
  await postContext(url, "st_alpha", sampleBody());

  expect(lastReq!.url).toBe(`${url}/ingest/context`);
  expect(lastReq!.auth).toBe("Bearer st_alpha");
  const sent = JSON.parse(lastReq!.body);
  expect(sent.record_id).toBe("11111111-1111-1111-1111-111111111111");
  expect(sent.course_code).toBe("ECE4721J");
  expect(sent.blob_hash).toBe("deadbeef");
});

test("202 -> created", async () => {
  const url = startFakeBackend(202);
  const r = await postContext(url, "st_x", sampleBody());
  expect(r).toEqual<PostContextResult>({
    kind: "created",
    record_id: "11111111-1111-1111-1111-111111111111",
  });
});

test("200 -> exists (idempotent replay)", async () => {
  const url = startFakeBackend(200);
  const r = await postContext(url, "st_x", sampleBody());
  expect(r).toEqual<PostContextResult>({
    kind: "exists",
    record_id: "11111111-1111-1111-1111-111111111111",
  });
});

test("409 -> conflict (body mismatch, never retry)", async () => {
  const url = startFakeBackend(409);
  const r = await postContext(url, "st_x", sampleBody());
  expect(r.kind).toBe("conflict");
});

test("401 / 403 / 400 -> fatal (auth or schema bug, never retry)", async () => {
  for (const status of [400, 401, 403, 422]) {
    const url = startFakeBackend(status);
    const r = await postContext(url, "st_x", sampleBody());
    expect(r.kind).toBe("fatal");
    if (r.kind === "fatal") expect(r.status).toBe(status);
    await fakeBackend?.stop(true);
    fakeBackend = undefined;
  }
});

test("503 / 500 / 429 -> retryable", async () => {
  for (const status of [429, 500, 502, 503]) {
    const url = startFakeBackend(status);
    const r = await postContext(url, "st_x", sampleBody());
    expect(r.kind).toBe("retryable");
    if (r.kind === "retryable") expect(r.status).toBe(status);
    await fakeBackend?.stop(true);
    fakeBackend = undefined;
  }
});

test("network error -> retryable", async () => {
  // unreachable port
  const r = await postContext(
    "http://127.0.0.1:1",
    "st_x",
    sampleBody(),
  );
  expect(r.kind).toBe("retryable");
});
