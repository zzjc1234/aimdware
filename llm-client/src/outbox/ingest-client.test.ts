import { test, expect, afterEach } from "bun:test";
import type { Server } from "bun";
import {
  postContext,
  type IngestBody,
  type PostContextResult,
} from "./ingest-client";

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
    session_id: "22222222-2222-2222-2222-222222222222",
    turn_count: 1,
    course_code: "ECE4721J",
    assignment: "hw1",
    blob_hash: "de".repeat(32),
    blob_uri: "aimdware/ECE4721J/hw1/22222222-2222-2222-2222-222222222222.json",
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
  expect(sent.blob_hash).toBe("de".repeat(32));
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
  const r = await postContext("http://127.0.0.1:1", "st_x", sampleBody());
  expect(r.kind).toBe("retryable");
});

// -------- confirmUploaded --------
import { confirmUploaded } from "./ingest-client";

test("confirmUploaded POSTs to /ingest/context/{id}/uploaded with bearer auth", async () => {
  const url = startFakeBackend(202);
  await confirmUploaded(url, "st_alpha", "abc-123");
  expect(lastReq!.url).toBe(`${url}/ingest/context/abc-123/uploaded`);
  expect(lastReq!.auth).toBe("Bearer st_alpha");
});

test("confirmUploaded: 200 / 202 -> ok", async () => {
  for (const status of [200, 202]) {
    const url = startFakeBackend(status);
    const r = await confirmUploaded(url, "st_x", "id");
    expect(r.kind).toBe("ok");
    await fakeBackend?.stop(true);
    fakeBackend = undefined;
  }
});

test("confirmUploaded: 5xx / 429 -> retryable; 4xx -> fatal", async () => {
  for (const status of [500, 503, 429]) {
    const url = startFakeBackend(status);
    expect((await confirmUploaded(url, "st_x", "id")).kind).toBe("retryable");
    await fakeBackend?.stop(true);
    fakeBackend = undefined;
  }
  for (const status of [400, 401, 404]) {
    const url = startFakeBackend(status);
    expect((await confirmUploaded(url, "st_x", "id")).kind).toBe("fatal");
    await fakeBackend?.stop(true);
    fakeBackend = undefined;
  }
});

test("confirmUploaded network error -> retryable", async () => {
  const r = await confirmUploaded("http://127.0.0.1:1", "st_x", "id");
  expect(r.kind).toBe("retryable");
});
