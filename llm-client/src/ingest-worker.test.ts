import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestQueue } from "./queue";
import type { IngestBody } from "./ingest";
import {
  nextBackoff,
  DEFAULT_BACKOFF,
  runOnce,
  type Stages,
  type StageHandler,
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
    session_id: `sess-${id}`,
    turn_count: 1,
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

const advance: StageHandler = async () => ({ kind: "advance" });
const stub3 = (h: StageHandler): Stages => ({ ingest: h, sync: h, confirm: h });

test("nextBackoff schedule: 1s, 5s, 30s, 5m, 30m, 1h cap", () => {
  expect(nextBackoff(0)).toBe(1_000);
  expect(nextBackoff(1)).toBe(5_000);
  expect(nextBackoff(2)).toBe(30_000);
  expect(nextBackoff(5)).toBe(60 * 60_000);
  expect(nextBackoff(99)).toBe(60 * 60_000);
  expect(DEFAULT_BACKOFF.length).toBe(6);
});

test("captured + ingest.advance -> state=ingested", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 0);
  await runOnce({ queue: q, stages: stub3(advance), now: () => 100 });
  expect(q.statusOf("r1")?.state).toBe("ingested");
  q.close();
});

test("ingested + sync.advance -> state=synced", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 0);
  q.advance("r1", "ingested", 0);
  await runOnce({ queue: q, stages: stub3(advance), now: () => 100 });
  expect(q.statusOf("r1")?.state).toBe("synced");
  q.close();
});

test("synced + confirm.advance -> state=done", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 0);
  q.advance("r1", "synced", 0);
  await runOnce({ queue: q, stages: stub3(advance), now: () => 100 });
  expect(q.statusOf("r1")?.state).toBe("done");
  q.close();
});

test("retry result: attempts++ and next_attempt_at scheduled by backoff", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 0);
  const retry: StageHandler = async () => ({ kind: "retry", reason: "503" });
  await runOnce({ queue: q, stages: stub3(retry), now: () => 1000 });
  let s = q.statusOf("r1")!;
  expect(s.state).toBe("captured");
  expect(s.attempts).toBe(1);
  expect(s.next_attempt_at).toBe(1000 + 1_000);

  await runOnce({ queue: q, stages: stub3(retry), now: () => 5000 });
  s = q.statusOf("r1")!;
  expect(s.attempts).toBe(2);
  expect(s.next_attempt_at).toBe(5000 + 5_000);
  q.close();
});

test("terminal -> markTerminal, no retry", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 0);
  const fatal: StageHandler = async () => ({
    kind: "terminal",
    finalState: "fatal",
    reason: "401",
  });
  await runOnce({ queue: q, stages: stub3(fatal), now: () => 1000 });
  expect(q.statusOf("r1")?.state).toBe("fatal");
  expect(q.statusOf("r1")?.last_error).toContain("401");
  q.close();
});

test("handler-throws is treated as retryable", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 0);
  const boom: StageHandler = async () => { throw new Error("kaboom"); };
  await runOnce({ queue: q, stages: stub3(boom), now: () => 0 });
  const s = q.statusOf("r1")!;
  expect(s.state).toBe("captured");
  expect(s.attempts).toBe(1);
  expect(s.last_error).toContain("kaboom");
  q.close();
});

test("nothing ready -> processed=0", async () => {
  const q = freshQueue();
  q.enqueue(body("r1"), 5000);
  const summary = await runOnce({ queue: q, stages: stub3(advance), now: () => 100 });
  expect(summary.processed).toBe(0);
  q.close();
});

test("dispatches the right handler per record state", async () => {
  const q = freshQueue();
  q.enqueue(body("a"), 0);                // captured -> ingest
  q.enqueue(body("b"), 0);
  q.advance("b", "ingested", 0);          // ingested -> sync
  q.enqueue(body("c"), 0);
  q.advance("c", "ingested", 0);
  q.advance("c", "synced", 0);            // synced -> confirm

  const called: string[] = [];
  const stages: Stages = {
    ingest:  async (b) => { called.push(`ingest:${b.record_id}`);  return { kind: "advance" }; },
    sync:    async (b) => { called.push(`sync:${b.record_id}`);    return { kind: "advance" }; },
    confirm: async (b) => { called.push(`confirm:${b.record_id}`); return { kind: "advance" }; },
  };
  await runOnce({ queue: q, stages, now: () => 100 });

  expect(called.sort()).toEqual(["confirm:c", "ingest:a", "sync:b"]);
  expect(q.statusOf("a")?.state).toBe("ingested");
  expect(q.statusOf("b")?.state).toBe("synced");
  expect(q.statusOf("c")?.state).toBe("done");
  q.close();
});

test("processes the batch in parallel up to concurrency", async () => {
  const q = freshQueue();
  for (let i = 0; i < 8; i++) q.enqueue(body(`r${i}`), 0);

  let inFlight = 0;
  let peak = 0;
  const slow: StageHandler = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(20);
    inFlight -= 1;
    return { kind: "advance" };
  };

  await runOnce(
    { queue: q, stages: stub3(slow), now: () => 0, concurrency: 4 },
    8,
  );

  expect(peak).toBeGreaterThanOrEqual(2);   // actually parallel (not serial)
  expect(peak).toBeLessThanOrEqual(4);      // bounded by concurrency
  for (let i = 0; i < 8; i++) {
    expect(q.statusOf(`r${i}`)?.state).toBe("ingested");
  }
  q.close();
});
