import { test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { IngestQueue } from "./queue";
import type { IngestBody } from "./ingest-client";
import {
  PendingSessionWrites,
  runEvictionOnce,
  runSessionCacheCleanupOnce,
} from "./eviction";

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

function body(
  record_id: string,
  session_id: string,
  turn_count = 1,
): IngestBody {
  return {
    record_id,
    session_id,
    turn_count,
    course_code: "ECE4721J",
    assignment: "hw1",
    blob_hash: "h",
    blob_uri: `jbox://x/${session_id}.json`,
    blob_size: 1,
    ts: "2026-05-12T00:00:00.000Z",
    router_version: "0.0.0",
  };
}

function backdate(cacheDir: string, record_id: string, createdMs: number) {
  const raw = new Database(join(cacheDir, "queue.db"));
  raw.exec(
    `UPDATE outbox SET created_at = ${createdMs} WHERE record_id = '${record_id}'`,
  );
  raw.close();
}

function setupDoneTurn(
  q: IngestQueue,
  cacheDir: string,
  recordsDir: string,
  record_id: string,
  session_id: string,
  turn_count: number,
  createdMs: number,
): void {
  q.enqueue(body(record_id, session_id, turn_count), 0);
  q.advance(record_id, "ingested", 0);
  q.advance(record_id, "synced", 0);
  q.advance(record_id, "done", 0);
  backdate(cacheDir, record_id, createdMs);
  // The cache file is keyed by SESSION_ID, not record_id, and is shared
  // across every turn of the same session.
  writeFileSync(
    join(recordsDir, `${session_id}.json`),
    `payload-${session_id}`,
  );
}

afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

const NOW = 100_000_000;
const TTL = 24 * 3600 * 1000;

test("pending session writes use refcounts for overlapping captures", () => {
  const pending = new PendingSessionWrites();

  pending.begin("S-overlap");
  pending.begin("S-overlap");
  pending.end("S-overlap");
  expect(pending.has("S-overlap")).toBe(true);
  pending.end("S-overlap");
  expect(pending.has("S-overlap")).toBe(false);
});

test("evicts a single-turn session past TTL: deletes <session_id>.json + marks record", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  setupDoneTurn(q, cacheDir, recordsDir, "r1", "S1", 1, NOW - TTL - 1000);

  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
  });
  expect(summary.sessions_evicted).toBe(1);
  expect(existsSync(join(recordsDir, "S1.json"))).toBe(false);
  expect(q.isEvicted("r1")).toBe(true);
  q.close();
});

test("evicts a multi-turn session ONCE: deletes one file, marks all N records", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  setupDoneTurn(q, cacheDir, recordsDir, "r1", "S-multi", 1, NOW - TTL - 3000);
  setupDoneTurn(q, cacheDir, recordsDir, "r2", "S-multi", 2, NOW - TTL - 2000);
  setupDoneTurn(q, cacheDir, recordsDir, "r3", "S-multi", 3, NOW - TTL - 1000);

  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
  });
  expect(summary.sessions_evicted).toBe(1);
  expect(existsSync(join(recordsDir, "S-multi.json"))).toBe(false);
  for (const r of ["r1", "r2", "r3"]) expect(q.isEvicted(r)).toBe(true);
  q.close();
});

test("does NOT evict a session that still has in-flight turns", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  // r1 is done + old; r2 is still captured (in progress)
  setupDoneTurn(q, cacheDir, recordsDir, "r1", "S-live", 1, NOW - TTL - 2000);
  q.enqueue(body("r2", "S-live", 2), 0);
  backdate(cacheDir, "r2", NOW - TTL - 1000);
  // File still in use by the live turn — must NOT be deleted.

  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
  });
  expect(summary.sessions_evicted).toBe(0);
  expect(existsSync(join(recordsDir, "S-live.json"))).toBe(true);
  expect(q.isEvicted("r1")).toBe(false);
  expect(q.isEvicted("r2")).toBe(false);
  q.close();
});

test("evicts terminal failure sessions past TTL", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  q.enqueue(body("r1", "S-terminal", 1), 0);
  q.markTerminal("r1", "fatal", "schema bug");
  backdate(cacheDir, "r1", NOW - TTL - 2000);
  q.enqueue(body("r2", "S-terminal", 2), 0);
  q.markTerminal("r2", "conflict", "body mismatch");
  backdate(cacheDir, "r2", NOW - TTL - 1000);
  writeFileSync(join(recordsDir, "S-terminal.json"), "payload");

  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
  });
  expect(summary.sessions_evicted).toBe(1);
  expect(existsSync(join(recordsDir, "S-terminal.json"))).toBe(false);
  expect(q.isEvicted("r1")).toBe(true);
  expect(q.isEvicted("r2")).toBe(true);
  q.close();
});

test("does NOT evict when the latest turn is still within TTL", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  setupDoneTurn(q, cacheDir, recordsDir, "r1", "S-fresh", 1, NOW - 5_000);
  setupDoneTurn(q, cacheDir, recordsDir, "r2", "S-fresh", 2, NOW - 1_000);
  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
  });
  expect(summary.sessions_evicted).toBe(0);
  expect(existsSync(join(recordsDir, "S-fresh.json"))).toBe(true);
  q.close();
});

test("cleanup deletes a session cache immediately once every turn is synced or later", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  q.enqueue(body("r1", "S-uploaded", 1), 0);
  q.advance("r1", "ingested", 0);
  q.advance("r1", "synced", 0);
  q.enqueue(body("r2", "S-uploaded", 2), 0);
  q.advance("r2", "ingested", 0);
  q.advance("r2", "synced", 0);
  writeFileSync(join(recordsDir, "S-uploaded.json"), "payload");

  const summary = await runSessionCacheCleanupOnce({
    queue: q,
    cacheDir,
    session_id: "S-uploaded",
  });

  expect(summary.sessions_evicted).toBe(1);
  expect(summary.records_marked).toBe(2);
  expect(existsSync(join(recordsDir, "S-uploaded.json"))).toBe(false);
  expect(q.isEvicted("r1")).toBe(true);
  expect(q.isEvicted("r2")).toBe(true);
  q.close();
});

test("cleanup skips a reclaimable session while a cache write is pending", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  q.enqueue(body("r1", "S-writing", 1), 0);
  q.advance("r1", "ingested", 0);
  q.advance("r1", "synced", 0);
  writeFileSync(join(recordsDir, "S-writing.json"), "payload");
  const pending = new PendingSessionWrites();
  pending.begin("S-writing");
  pending.begin("S-writing");
  pending.end("S-writing");

  const skipped = await runSessionCacheCleanupOnce({
    queue: q,
    cacheDir,
    session_id: "S-writing",
    isSessionPending: pending.has,
  });
  expect(skipped.sessions_evicted).toBe(0);
  expect(existsSync(join(recordsDir, "S-writing.json"))).toBe(true);
  expect(q.isEvicted("r1")).toBe(false);

  pending.end("S-writing");
  const cleaned = await runSessionCacheCleanupOnce({
    queue: q,
    cacheDir,
    session_id: "S-writing",
    isSessionPending: pending.has,
  });
  expect(cleaned.sessions_evicted).toBe(1);
  expect(existsSync(join(recordsDir, "S-writing.json"))).toBe(false);
  expect(q.isEvicted("r1")).toBe(true);
  q.close();
});

test("cleanup keeps a session cache while any turn still needs upload", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  q.enqueue(body("r1", "S-pending", 1), 0);
  q.advance("r1", "ingested", 0);
  q.advance("r1", "synced", 0);
  q.enqueue(body("r2", "S-pending", 2), 0);
  q.advance("r2", "ingested", 0);
  writeFileSync(join(recordsDir, "S-pending.json"), "payload");

  const summary = await runSessionCacheCleanupOnce({
    queue: q,
    cacheDir,
    session_id: "S-pending",
  });

  expect(summary.sessions_evicted).toBe(0);
  expect(summary.records_marked).toBe(0);
  expect(existsSync(join(recordsDir, "S-pending.json"))).toBe(true);
  expect(q.isEvicted("r1")).toBe(false);
  expect(q.isEvicted("r2")).toBe(false);
  q.close();
});

test("ttl eviction cleans up old synced sessions if fast cleanup was missed", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  q.enqueue(body("r1", "S-synced-old", 1), 0);
  q.advance("r1", "ingested", 0);
  q.advance("r1", "synced", 0);
  backdate(cacheDir, "r1", NOW - TTL - 1000);
  writeFileSync(join(recordsDir, "S-synced-old.json"), "payload");

  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
  });

  expect(summary.sessions_evicted).toBe(1);
  expect(existsSync(join(recordsDir, "S-synced-old.json"))).toBe(false);
  expect(q.isEvicted("r1")).toBe(true);
  q.close();
});

test("ttl eviction skips an old synced session while a cache write is pending", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  q.enqueue(body("r1", "S-ttl-writing", 1), 0);
  q.advance("r1", "ingested", 0);
  q.advance("r1", "synced", 0);
  backdate(cacheDir, "r1", NOW - TTL - 1000);
  writeFileSync(join(recordsDir, "S-ttl-writing.json"), "payload");
  const pending = new PendingSessionWrites();
  pending.begin("S-ttl-writing");

  const skipped = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
    isSessionPending: pending.has,
  });
  expect(skipped.sessions_evicted).toBe(0);
  expect(existsSync(join(recordsDir, "S-ttl-writing.json"))).toBe(true);
  expect(q.isEvicted("r1")).toBe(false);

  pending.end("S-ttl-writing");
  const cleaned = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
    isSessionPending: pending.has,
  });
  expect(cleaned.sessions_evicted).toBe(1);
  expect(existsSync(join(recordsDir, "S-ttl-writing.json"))).toBe(false);
  expect(q.isEvicted("r1")).toBe(true);
  q.close();
});

test("idempotent: a second pass after a successful eviction is a no-op", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  setupDoneTurn(q, cacheDir, recordsDir, "r1", "S1", 1, NOW - TTL - 1000);

  const first = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
  });
  expect(first.sessions_evicted).toBe(1);
  const second = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
  });
  expect(second.sessions_evicted).toBe(0);
  q.close();
});

test("tolerates a missing file (already removed out-of-band) — still marks records evicted", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  setupDoneTurn(q, cacheDir, recordsDir, "r1", "S-ghost", 1, NOW - TTL - 1000);
  rmSync(join(recordsDir, "S-ghost.json"));

  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
  });
  expect(summary.sessions_evicted).toBe(1);
  expect(q.isEvicted("r1")).toBe(true);
  q.close();
});

test("does NOT mark evicted when unlink fails", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  setupDoneTurn(
    q,
    cacheDir,
    recordsDir,
    "r1",
    "S-blocked",
    1,
    NOW - TTL - 1000,
  );
  rmSync(join(recordsDir, "S-blocked.json"));
  mkdirSync(join(recordsDir, "S-blocked.json"));

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const summary = await runEvictionOnce({
      queue: q,
      cacheDir,
      now: () => NOW,
      ttlMs: TTL,
    });
    expect(summary.sessions_evicted).toBe(0);
    expect(summary.records_marked).toBe(0);
    expect(q.isEvicted("r1")).toBe(false);
    expect(warnings.join("\n")).toContain(
      "unlink failed for session S-blocked",
    );
  } finally {
    console.warn = origWarn;
    q.close();
  }
});

test("limit caps the number of sessions per pass", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  for (let i = 0; i < 5; i++) {
    setupDoneTurn(
      q,
      cacheDir,
      recordsDir,
      `r${i}`,
      `S${i}`,
      1,
      NOW - TTL - 1000 - i,
    );
  }
  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
    limit: 2,
  });
  expect(summary.sessions_evicted).toBe(2);
  q.close();
});

test("evicts multiple distinct sessions in one pass", async () => {
  const { cacheDir, recordsDir, q } = fresh();
  setupDoneTurn(q, cacheDir, recordsDir, "r1", "S-a", 1, NOW - TTL - 1000);
  setupDoneTurn(q, cacheDir, recordsDir, "r2", "S-b", 1, NOW - TTL - 2000);
  setupDoneTurn(q, cacheDir, recordsDir, "r3", "S-c", 1, NOW - 1_000); // fresh
  const summary = await runEvictionOnce({
    queue: q,
    cacheDir,
    now: () => NOW,
    ttlMs: TTL,
  });
  expect(summary.sessions_evicted).toBe(2);
  expect(existsSync(join(recordsDir, "S-a.json"))).toBe(false);
  expect(existsSync(join(recordsDir, "S-b.json"))).toBe(false);
  expect(existsSync(join(recordsDir, "S-c.json"))).toBe(true);
  q.close();
});
