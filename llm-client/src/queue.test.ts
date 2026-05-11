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

test("enqueue starts in 'captured' state", () => {
  const { q } = freshDb();
  q.enqueue(body("r1"), 0);
  expect(q.statusOf("r1")?.state).toBe("captured");
  q.close();
});

test("pickReady returns active records past their next_attempt_at", () => {
  const { q } = freshDb();
  q.enqueue(body("r1"), 100);
  expect(q.pickReady(50, 10)).toHaveLength(0);
  const r = q.pickReady(100, 10);
  expect(r).toHaveLength(1);
  expect(r[0]!.body.record_id).toBe("r1");
  expect(r[0]!.state).toBe("captured");
  q.close();
});

test("advance moves through the lifecycle and resets attempts", () => {
  const { q } = freshDb();
  q.enqueue(body("r1"), 0);

  q.markRetry("r1", "blip", 100); // attempts=1
  expect(q.statusOf("r1")?.attempts).toBe(1);

  q.advance("r1", "ingested", 100);
  let s = q.statusOf("r1")!;
  expect(s.state).toBe("ingested");
  expect(s.attempts).toBe(0);
  expect(s.last_error).toBeNull();

  q.advance("r1", "synced", 200);
  expect(q.statusOf("r1")?.state).toBe("synced");

  q.advance("r1", "done", 300);
  expect(q.statusOf("r1")?.state).toBe("done");
  expect(q.pickReady(1000, 10)).toHaveLength(0);
  q.close();
});

test("markRetry keeps state and bumps attempts + next_attempt_at", () => {
  const { q } = freshDb();
  q.enqueue(body("r1"), 0);
  q.markRetry("r1", "503", 5000);
  expect(q.pickReady(1000, 10)).toHaveLength(0);
  expect(q.pickReady(5000, 10)).toHaveLength(1);
  const s = q.statusOf("r1")!;
  expect(s.state).toBe("captured");
  expect(s.attempts).toBe(1);
  expect(s.last_error).toBe("503");
  q.close();
});

test("markTerminal: conflict and fatal remove from pickReady", () => {
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

test("enqueue is idempotent on duplicate record_id", () => {
  const { q } = freshDb();
  q.enqueue(body("r1"), 0);
  q.enqueue(body("r1"), 100);
  expect(q.pickReady(1000, 10)).toHaveLength(1);
  q.close();
});

test("state survives reopening the db file", () => {
  const { path, q } = freshDb();
  q.enqueue(body("a"), 0);
  q.enqueue(body("b"), 0);
  q.advance("a", "ingested", 0);
  q.advance("a", "synced", 0);
  q.close();

  const q2 = new IngestQueue(path);
  expect(q2.statusOf("a")?.state).toBe("synced");
  expect(q2.statusOf("b")?.state).toBe("captured");
  q2.close();
});

test("pickReady respects limit + orders ascending by next_attempt_at", () => {
  const { q } = freshDb();
  q.enqueue(body("c"), 30);
  q.enqueue(body("a"), 10);
  q.enqueue(body("b"), 20);
  const ready = q.pickReady(1000, 2);
  expect(ready.map((r) => r.body.record_id)).toEqual(["a", "b"]);
  q.close();
});

test("pickReady returns records in any active state (captured / ingested / synced)", () => {
  const { q } = freshDb();
  q.enqueue(body("a"), 0);
  q.enqueue(body("b"), 0);
  q.enqueue(body("c"), 0);
  q.advance("b", "ingested", 0);
  q.advance("c", "ingested", 0);
  q.advance("c", "synced", 0);

  const ready = q.pickReady(1000, 10);
  const byState = Object.fromEntries(ready.map((r) => [r.body.record_id, r.state]));
  expect(byState).toEqual({ a: "captured", b: "ingested", c: "synced" });
  q.close();
});
