import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestQueue } from "./queue";
import type { IngestBody } from "./ingest";

const tmpDirs: string[] = [];

function freshDb(): { path: string; q: IngestQueue } {
  const dir = mkdtempSync(join(tmpdir(), "aimdware-queue-"));
  tmpDirs.push(dir);
  const path = join(dir, "queue.db");
  return { path, q: new IngestQueue(path) };
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

test("enqueue + pickReady returns the inserted row", () => {
  const { q } = freshDb();
  q.enqueue(body("r1"), 100);
  const ready = q.pickReady(100, 10);
  expect(ready).toHaveLength(1);
  expect(ready[0]!.record_id).toBe("r1");
  q.close();
});

test("pickReady excludes rows scheduled for the future", () => {
  const { q } = freshDb();
  q.enqueue(body("r1"), 200);
  expect(q.pickReady(100, 10)).toHaveLength(0);
  expect(q.pickReady(200, 10)).toHaveLength(1);
  q.close();
});

test("markSent removes from pickReady", () => {
  const { q } = freshDb();
  q.enqueue(body("r1"), 0);
  q.markSent("r1", "created");
  expect(q.pickReady(1000, 10)).toHaveLength(0);
  q.close();
});

test("markRetry updates attempts + next_attempt_at and keeps pending", () => {
  const { q } = freshDb();
  q.enqueue(body("r1"), 0);
  q.markRetry("r1", "503", 5000);
  expect(q.pickReady(1000, 10)).toHaveLength(0);
  expect(q.pickReady(5000, 10)).toHaveLength(1);
  const status = q.statusOf("r1");
  expect(status?.attempts).toBe(1);
  expect(status?.last_error).toBe("503");
  q.close();
});

test("markTerminal (conflict | fatal) removes from pickReady", () => {
  const { q } = freshDb();
  q.enqueue(body("a"), 0);
  q.enqueue(body("b"), 0);
  q.markTerminal("a", "conflict", "body mismatch");
  q.markTerminal("b", "fatal", "401");
  expect(q.pickReady(1000, 10)).toHaveLength(0);
  expect(q.statusOf("a")?.state).toBe("conflict");
  expect(q.statusOf("b")?.state).toBe("fatal");
  q.close();
});

test("enqueue is idempotent on duplicate record_id (no double insert)", () => {
  const { q } = freshDb();
  q.enqueue(body("r1"), 0);
  q.enqueue(body("r1"), 100); // second call with same id
  const ready = q.pickReady(1000, 10);
  expect(ready).toHaveLength(1);
  q.close();
});

test("state survives reopening the db file", () => {
  const { path, q } = freshDb();
  q.enqueue(body("r1"), 0);
  q.enqueue(body("r2"), 50);
  q.markSent("r1", "created");
  q.close();

  const q2 = new IngestQueue(path);
  const remaining = q2.pickReady(1000, 10);
  expect(remaining).toHaveLength(1);
  expect(remaining[0]!.record_id).toBe("r2");
  q2.close();
});

test("pickReady respects limit and orders by next_attempt_at ascending", () => {
  const { q } = freshDb();
  q.enqueue(body("c"), 30);
  q.enqueue(body("a"), 10);
  q.enqueue(body("b"), 20);
  const ready = q.pickReady(1000, 2);
  expect(ready.map((r) => r.record_id)).toEqual(["a", "b"]);
  q.close();
});
