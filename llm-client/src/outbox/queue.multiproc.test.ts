import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestQueue } from "./queue";
import type { IngestBody } from "./ingest-client";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

function body(id: string): IngestBody {
  return {
    record_id: id,
    session_id: `sess-${id}`,
    turn_count: 1,
    course_code: "ECE4721J",
    assignment: "hw1",
    blob_hash: "h",
    blob_uri: `jbox://x/${id}.json`,
    blob_size: 1,
    ts: "2026-05-13T00:00:00.000Z",
    router_version: "0.0.0",
  };
}

async function spawnClaimer(
  scriptPath: string,
  dbPath: string,
  limit: number,
): Promise<string[]> {
  const proc = Bun.spawn(["bun", scriptPath, dbPath, String(limit)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`claimer exited ${code}: ${err}`);
  return JSON.parse(out) as string[];
}

test("two processes calling claim() on the same db get disjoint record_ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aimdware-multiproc-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "queue.db");

  const q = new IngestQueue(dbPath);
  for (let i = 0; i < 200; i++) {
    q.enqueue(body(`r${i.toString().padStart(3, "0")}`), 0);
  }
  q.close();

  const queueModule = join(import.meta.dir, "queue.ts");
  const workerScript = join(dir, "claimer.ts");
  writeFileSync(
    workerScript,
    `import { IngestQueue } from ${JSON.stringify(queueModule)};
const q = new IngestQueue(process.argv[2]);
const claimed = q.claim(Date.now(), parseInt(process.argv[3], 10));
process.stdout.write(JSON.stringify(claimed.map((c) => c.body.record_id)));
q.close();
`,
  );

  const [idsA, idsB] = await Promise.all([
    spawnClaimer(workerScript, dbPath, 100),
    spawnClaimer(workerScript, dbPath, 100),
  ]);

  // Union covers all 200, intersection is empty — atomic claim.
  const both = [...idsA, ...idsB].sort();
  const expected = Array.from(
    { length: 200 },
    (_, i) => `r${i.toString().padStart(3, "0")}`,
  );
  expect(both).toEqual(expected);

  const setB = new Set(idsB);
  const overlap = idsA.filter((id) => setB.has(id));
  expect(overlap).toEqual([]);

  // SQLite serializes writers, so one process gets the full batch and the other gets the remainder.
  expect(idsA.length + idsB.length).toBe(200);
  expect(idsA.length).toBeGreaterThan(0);
  expect(idsB.length).toBeGreaterThan(0);
});

test("three processes racing on a smaller pool — disjoint claims, exactly one wins each row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aimdware-multiproc-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "queue.db");

  const q = new IngestQueue(dbPath);
  for (let i = 0; i < 30; i++) q.enqueue(body(`x${i}`), 0);
  q.close();

  const queueModule = join(import.meta.dir, "queue.ts");
  const workerScript = join(dir, "claimer.ts");
  writeFileSync(
    workerScript,
    `import { IngestQueue } from ${JSON.stringify(queueModule)};
const q = new IngestQueue(process.argv[2]);
const claimed = q.claim(Date.now(), parseInt(process.argv[3], 10));
process.stdout.write(JSON.stringify(claimed.map((c) => c.body.record_id)));
q.close();
`,
  );

  const results = await Promise.all([
    spawnClaimer(workerScript, dbPath, 20),
    spawnClaimer(workerScript, dbPath, 20),
    spawnClaimer(workerScript, dbPath, 20),
  ]);

  const all = results.flat();
  // Every record claimed exactly once.
  expect(all.sort()).toEqual(
    Array.from({ length: 30 }, (_, i) => `x${i}`).sort(),
  );
  expect(new Set(all).size).toBe(30);
});
