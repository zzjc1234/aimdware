/**
 * Tests the sync stage's interaction with the session-keyed cache file.
 *
 * The redesign keeps ONE file per session on disk (overwritten on each
 * turn). When the worker fires the sync stage for turn N, the file may
 * already contain turn N+1's bytes (a newer turn beat the worker). We
 * accept that — the latest state is what we want on jbox — but it has
 * to be tested, otherwise a refactor could silently break it and only
 * the real-Tbox bash smoke would catch it.
 */
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyncStage } from "./main";
import type { WebDAVPutLike } from "./outbox/sync";
import type { IngestBody } from "./outbox/ingest-client";
import { writeAtomic } from "./util";

const tmpDirs: string[] = [];
function fresh() {
  const d = mkdtempSync(join(tmpdir(), "aimdware-mainsync-"));
  tmpDirs.push(d);
  const cacheDir = join(d, "cache");
  mkdirSync(join(cacheDir, "records"), { recursive: true });
  return { cacheDir };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

function recordingPut(): {
  put: WebDAVPutLike;
  uploads: Array<{ path: string; bytes: Uint8Array }>;
} {
  const uploads: Array<{ path: string; bytes: Uint8Array }> = [];
  const put: WebDAVPutLike = async (path, bytes) => {
    uploads.push({ path, bytes: new Uint8Array(bytes) });
  };
  return { put, uploads };
}

function body(
  record_id: string,
  session_id: string,
  turn_count: number,
): IngestBody {
  return {
    record_id,
    session_id,
    turn_count,
    course_code: "X",
    blob_hash: "abc",
    blob_uri: `aimdware/X/${session_id}.json`,
    blob_size: 0,
    ts: new Date(0).toISOString(),
    router_version: "0.0.0",
  };
}

test("sync stage reads <session_id>.json (NOT <record_id>.json) and PUTs those bytes", async () => {
  const { cacheDir } = fresh();
  const { put, uploads } = recordingPut();
  const bytes = new TextEncoder().encode("turn-1-blob");
  await writeAtomic(join(cacheDir, "records", "S1.json"), bytes);

  const stage = buildSyncStage(cacheDir, put);
  const result = await stage(body("r1", "S1", 1));

  expect(result).toEqual({ kind: "advance" });
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.path).toBe("/aimdware/X/S1.json");
  expect(new TextDecoder().decode(uploads[0]!.bytes)).toBe("turn-1-blob");
});

test("sync stage uploads WHATEVER is currently on disk — a later turn's overwrite wins", async () => {
  const { cacheDir } = fresh();
  const { put, uploads } = recordingPut();
  const filePath = join(cacheDir, "records", "S-race.json");
  const stage = buildSyncStage(cacheDir, put);

  // Capture turn 1 — write its bytes.
  await writeAtomic(filePath, new TextEncoder().encode("turn-1"));

  // Capture turn 2 — overwrites the file BEFORE the worker fires turn 1's sync.
  await writeAtomic(filePath, new TextEncoder().encode("turn-2-final"));

  // Worker fires sync for turn 1 — reads disk (now turn-2 bytes), PUTs them.
  const r1 = await stage(body("r1", "S-race", 1));
  expect(r1).toEqual({ kind: "advance" });
  expect(new TextDecoder().decode(uploads[0]!.bytes)).toBe("turn-2-final");

  // Worker fires sync for turn 2 — reads same disk, PUTs same bytes.
  const r2 = await stage(body("r2", "S-race", 2));
  expect(r2).toEqual({ kind: "advance" });
  expect(new TextDecoder().decode(uploads[1]!.bytes)).toBe("turn-2-final");

  // BOTH PUTs went to the same session-keyed jbox path.
  expect(uploads[0]!.path).toBe(uploads[1]!.path);
  expect(uploads[0]!.path).toBe("/aimdware/X/S-race.json");
});

test("sync stage in parallel: 3 PUTs for one session all carry the latest disk bytes", async () => {
  const { cacheDir } = fresh();
  const { put, uploads } = recordingPut();
  const filePath = join(cacheDir, "records", "S-par.json");
  await writeAtomic(filePath, new TextEncoder().encode("final-state"));

  const stage = buildSyncStage(cacheDir, put);
  await Promise.all([
    stage(body("r1", "S-par", 1)),
    stage(body("r2", "S-par", 2)),
    stage(body("r3", "S-par", 3)),
  ]);
  expect(uploads).toHaveLength(3);
  for (const u of uploads) {
    expect(new TextDecoder().decode(u.bytes)).toBe("final-state");
  }
});

test("sync stage returns terminal/fatal when the session cache file is gone", async () => {
  const { cacheDir } = fresh();
  const { put, uploads } = recordingPut();
  const stage = buildSyncStage(cacheDir, put);

  const r = await stage(body("r1", "S-missing", 1));
  expect(r.kind).toBe("terminal");
  if (r.kind === "terminal") expect(r.finalState).toBe("fatal");
  expect(uploads).toHaveLength(0);
});

test("sync stage routes WebDAV errors through the result kind", async () => {
  const { cacheDir } = fresh();
  await writeAtomic(
    join(cacheDir, "records", "S-err.json"),
    new TextEncoder().encode("x"),
  );

  // 500 -> retryable
  const flaky500: WebDAVPutLike = async () => {
    throw Object.assign(new Error("upstream blew up"), { status: 500 });
  };
  const r500 = await buildSyncStage(cacheDir, flaky500)(body("r1", "S-err", 1));
  expect(r500.kind).toBe("retry");

  // 401 -> fatal
  const auth401: WebDAVPutLike = async () => {
    throw Object.assign(new Error("nope"), { status: 401 });
  };
  const r401 = await buildSyncStage(cacheDir, auth401)(body("r2", "S-err", 1));
  expect(r401.kind).toBe("terminal");
});
