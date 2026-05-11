import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestQueue } from "./queue";
import type { IngestBody, PostContextResult } from "./ingest";
import {
  nextBackoff,
  DEFAULT_BACKOFF,
  runOnce,
  type PostContextImpl,
} from "./ingest-worker";

const tmpDirs: string[] = [];
function freshQueue() {
  const d = mkdtempSync(join(tmpdir(), "aimdware-worker-"));
  tmpDirs.push(d);
  return new IngestQueue(join(d, "queue.db"));
}
function body(id: string): IngestBody {
  return {
    record_id: id,
    course_code: "ECE4721J",
    blob_hash: "h",
    blob_uri: `jbox://x/${id}.json`,
    blob_size: 1,
    ts: "2026-05-11T00:00:00.000Z",
    router_version: "0.0.0",
  };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("nextBackoff schedule: 1s, 5s, 30s, 5m, 30m, 1h (cap)", () => {
  expect(nextBackoff(0)).toBe(1_000);
  expect(nextBackoff(1)).toBe(5_000);
  expect(nextBackoff(2)).toBe(30_000);
  expect(nextBackoff(3)).toBe(5 * 60_000);
  expect(nextBackoff(4)).toBe(30 * 60_000);
  expect(nextBackoff(5)).toBe(60 * 60_000);
  expect(nextBackoff(99)).toBe(60 * 60_000);
  expect(DEFAULT_BACKOFF.length).toBe(6);
});

test("runOnce: 202 -> markSent", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 0);
  const fake: PostContextImpl = async () => ({ kind: "created", record_id: "r1" });
  const summary = await runOnce({
    queue: q,
    backendUrl: "http://stub",
    studentToken: "st",
    postContextImpl: fake,
    now: () => 1000,
  });
  expect(summary.created).toBe(1);
  expect(q.statusOf("r1")?.state).toBe("sent");
  q.close();
});

test("runOnce: 200 -> exists also moves to sent", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 0);
  const fake: PostContextImpl = async () => ({ kind: "exists", record_id: "r1" });
  const summary = await runOnce({
    queue: q,
    backendUrl: "http://stub",
    studentToken: "st",
    postContextImpl: fake,
    now: () => 1000,
  });
  expect(summary.exists).toBe(1);
  expect(q.statusOf("r1")?.state).toBe("sent");
  q.close();
});

test("runOnce: retryable -> markRetry with exponential backoff", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 0);
  const fake: PostContextImpl = async () => ({
    kind: "retryable",
    status: 503,
    reason: "down",
  });

  await runOnce({
    queue: q,
    backendUrl: "http://stub",
    studentToken: "st",
    postContextImpl: fake,
    now: () => 1000,
  });

  let s = q.statusOf("r1")!;
  expect(s.state).toBe("pending");
  expect(s.attempts).toBe(1);
  expect(s.next_attempt_at).toBe(1000 + 1_000);

  // simulate time passing, retry again, attempts grows + backoff grows
  await runOnce({
    queue: q,
    backendUrl: "http://stub",
    studentToken: "st",
    postContextImpl: fake,
    now: () => 5000,
  });
  s = q.statusOf("r1")!;
  expect(s.attempts).toBe(2);
  expect(s.next_attempt_at).toBe(5000 + 5_000);

  q.close();
});

test("runOnce: conflict -> markTerminal(conflict), no retry", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 0);
  const fake: PostContextImpl = async () => ({ kind: "conflict" });
  await runOnce({
    queue: q,
    backendUrl: "http://stub",
    studentToken: "st",
    postContextImpl: fake,
    now: () => 1000,
  });
  expect(q.statusOf("r1")?.state).toBe("conflict");
  expect(q.pickReady(Number.MAX_SAFE_INTEGER, 10)).toHaveLength(0);
  q.close();
});

test("runOnce: fatal -> markTerminal(fatal), no retry", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 0);
  const fake: PostContextImpl = async () => ({
    kind: "fatal",
    status: 401,
    reason: "auth",
  });
  await runOnce({
    queue: q,
    backendUrl: "http://stub",
    studentToken: "st",
    postContextImpl: fake,
    now: () => 1000,
  });
  expect(q.statusOf("r1")?.state).toBe("fatal");
  expect(q.statusOf("r1")?.last_error).toContain("auth");
  q.close();
});

test("runOnce: nothing ready -> processed = 0", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 5000); // scheduled in the future
  const fake: PostContextImpl = async () => ({ kind: "created", record_id: "r1" });
  const summary = await runOnce({
    queue: q,
    backendUrl: "http://stub",
    studentToken: "st",
    postContextImpl: fake,
    now: () => 1000,
  });
  expect(summary.processed).toBe(0);
  q.close();
});

test("runOnce: multiple records in one pass", async () => {
  const q = freshQueue();
  q.enqueue(body("a"), 0);
  q.enqueue(body("b"), 0);
  q.enqueue(body("c"), 5000); // not ready
  const fake: PostContextImpl = async (_b, _t, body) => ({
    kind: "created",
    record_id: body.record_id,
  });
  const summary = await runOnce({
    queue: q,
    backendUrl: "http://stub",
    studentToken: "st",
    postContextImpl: fake,
    now: () => 1000,
  });
  expect(summary.processed).toBe(2);
  expect(summary.created).toBe(2);
  expect(q.statusOf("a")?.state).toBe("sent");
  expect(q.statusOf("b")?.state).toBe("sent");
  expect(q.statusOf("c")?.state).toBe("pending");
  q.close();
});
