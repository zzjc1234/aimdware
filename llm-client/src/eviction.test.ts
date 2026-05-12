import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestQueue } from "./queue";
import type { IngestBody } from "./ingest";
import { runEvictionOnce } from "./eviction";

const tmpDirs: string[] = [];
function fresh() {
  const d = mkdtempSync(join(tmpdir(), "aimdware-evict-"));
  tmpDirs.push(d);
  const cacheDir = join(d, "cache");
  const recordsDir = join(cacheDir, "records");
  require("node:fs").mkdirSync(recordsDir, { recursive: true });
  const q = new IngestQueue(join(cacheDir, "queue.db"));
  return { d, cacheDir, recordsDir, q };
}

function body(id: string): IngestBody {
  return {
    record_id: id,
    course_code: "ECE4721J",
    blob_hash: "h",
    blob_uri: `jbox://x/${id}.json`,
    blob_size: 1,
    ts: "2026-05-12T00:00:00.000Z",
    router_version: "0.0.0",
  };
}

function setupDoneRecord(
  q: IngestQueue,
  recordsDir: string,
  id: string,
  createdMs: number,
) {
  // bypass enqueue's now() by inserting raw, then advance
  q.enqueue(body(id), 0);
  q.advance(id, "ingested", 0);
  q.advance(id, "synced", 0);
  q.advance(id, "done", 0);
  // We need to backdate created_at; use raw sql for the test fixture.
  const Database = require("bun:sqlite").Database;
  const raw = new Database(join(recordsDir, "..", "queue.db"));
  raw.exec(`UPDATE outbox SET created_at = ${createdMs} WHERE record_id = '${id}'`);
  raw.close();
  writeFileSync(join(recordsDir, `${id}.json`), `payload-${id}`);
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("runEvictionOnce deletes file + marks evicted for done records older than ttl", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  const NOW = 100_000_000;
  const TTL_MS = 7 * 24 * 3600 * 1000;
  setupDoneRecord(q, recordsDir, "old", NOW - TTL_MS - 1000); // older than ttl
  setupDoneRecord(q, recordsDir, "fresh", NOW - 1000);        // within ttl

  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL_MS,
  });

  expect(summary.evicted).toBe(1);
  expect(existsSync(join(recordsDir, "old.json"))).toBe(false);
  expect(existsSync(join(recordsDir, "fresh.json"))).toBe(true);
  expect(q.isEvicted("old")).toBe(true);
  expect(q.isEvicted("fresh")).toBe(false);
  q.close();
});

test("runEvictionOnce ignores records not in 'done' state", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  const NOW = 100_000_000;
  const TTL_MS = 7 * 24 * 3600 * 1000;
  // captured / ingested / synced — even if old, do not evict
  q.enqueue(body("a"), 0);
  q.enqueue(body("b"), 0);
  q.advance("b", "ingested", 0);
  q.enqueue(body("c"), 0);
  q.advance("c", "ingested", 0);
  q.advance("c", "synced", 0);
  for (const id of ["a", "b", "c"]) {
    const raw = new (require("bun:sqlite").Database)(join(cacheDir, "queue.db"));
    raw.exec(`UPDATE outbox SET created_at = ${NOW - TTL_MS - 1000} WHERE record_id = '${id}'`);
    raw.close();
    writeFileSync(join(recordsDir, `${id}.json`), "x");
  }

  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL_MS,
  });

  expect(summary.evicted).toBe(0);
  for (const id of ["a", "b", "c"]) {
    expect(existsSync(join(recordsDir, `${id}.json`))).toBe(true);
  }
  q.close();
});

test("runEvictionOnce idempotent when file is already missing", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  const NOW = 100_000_000;
  const TTL_MS = 7 * 24 * 3600 * 1000;
  setupDoneRecord(q, recordsDir, "ghost", NOW - TTL_MS - 1000);
  rmSync(join(recordsDir, "ghost.json")); // simulate the file having been removed by hand

  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL_MS,
  });

  // Still counted as evicted; the row's cache_evicted flag is what we trust.
  expect(summary.evicted).toBe(1);
  expect(q.isEvicted("ghost")).toBe(true);
  q.close();
});

test("runEvictionOnce skips records already marked cache_evicted", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  const NOW = 100_000_000;
  const TTL_MS = 7 * 24 * 3600 * 1000;
  setupDoneRecord(q, recordsDir, "already", NOW - TTL_MS - 1000);
  q.markEvicted("already");
  rmSync(join(recordsDir, "already.json"));

  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL_MS,
  });

  expect(summary.evicted).toBe(0);
  q.close();
});

test("runEvictionOnce respects limit", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  const NOW = 100_000_000;
  const TTL_MS = 7 * 24 * 3600 * 1000;
  for (let i = 0; i < 5; i++) {
    setupDoneRecord(q, recordsDir, `r${i}`, NOW - TTL_MS - 1000 - i);
  }
  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL_MS,
    limit: 2,
  });
  expect(summary.evicted).toBe(2);
  q.close();
});
