// Cross-process concurrency test for codex subscription token refresh.
//
// Spawns N real OS processes that all refresh the same expired credential at
// once (synchronized by a barrier) against a fake OAuth server with single-use
// rotating refresh tokens. The server holds the winner mid-refresh for 50ms so
// the losers are guaranteed to collide while the rotation is uncommitted.
//
// In "lock" mode (the shipping behaviour) the cross-process file lock must make
// exactly one network refresh happen and let every process succeed. The run is
// repeated and asserted; it exits non-zero on any violation. A single "nolock"
// run is printed afterwards purely as an informational contrast.
//
//   bun run test-scripts/concurrency/run.ts
//   CONC_PROCESSES=8 CONC_RUNS=3 bun run test-scripts/concurrency/run.ts
import {
  authFilePath,
  createFileAuthStore,
} from "../../llm-client/src/providers/auth-store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = Number(process.env.CONC_PROCESSES ?? 8);
const RUNS = Number(process.env.CONC_RUNS ?? 3);
const childPath = join(import.meta.dir, "child.ts");

type Outcome = {
  rotations: number;
  ok: number;
  err: number;
  final: unknown;
  outs: string[];
};

async function once(mode: "lock" | "nolock"): Promise<Outcome> {
  const cacheDir = mkdtempSync(join(tmpdir(), "aimdware-conc-"));

  // Fake OAuth endpoint with single-use rotating refresh tokens.
  let validRefresh = "R0";
  let rotations = 0;
  const oauth = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const params = new URLSearchParams(await req.text());
      if (params.get("refresh_token") === validRefresh) {
        rotations++;
        validRefresh = "R" + rotations;
        // Hold the winner so any loser is in flight (or blocked on the lock)
        // while this rotation is still uncommitted.
        await new Promise((r) => setTimeout(r, 50));
        return Response.json({
          access_token: "acc" + rotations,
          refresh_token: validRefresh,
          expires_in: 3600,
        });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
  });

  // Barrier: release all children at once so the refreshes truly collide.
  let waiters: Array<(r: Response) => void> = [];
  const barrier = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Promise<Response>((resolve) => {
        waiters.push(resolve);
        if (waiters.length >= N) {
          for (const w of waiters) w(new Response("go"));
          waiters = [];
        }
      });
    },
  });

  const store = createFileAuthStore(authFilePath(cacheDir));
  await store.set("codex", {
    type: "oauth",
    access: "old",
    refresh: "R0",
    expires: 1,
  });

  const procs = Array.from({ length: N }, () =>
    Bun.spawn(
      [
        "bun",
        "run",
        childPath,
        cacheDir,
        String(oauth.port),
        mode,
        String(barrier.port),
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  const outs = await Promise.all(
    procs.map(async (p) => {
      const out = await new Response(p.stdout).text();
      await p.exited;
      return out.trim();
    }),
  );

  const final = await store.get("codex");
  oauth.stop(true);
  barrier.stop(true);
  rmSync(cacheDir, { recursive: true, force: true });

  return {
    rotations,
    ok: outs.filter((o) => o.startsWith("OK")).length,
    err: outs.filter((o) => o.startsWith("ERR")).length,
    final,
    outs,
  };
}

const access = (final: unknown) =>
  final ? (final as { access?: string }).access : "DELETED";

let failed = false;
for (let i = 1; i <= RUNS; i++) {
  const r = await once("lock");
  // With the lock: exactly one network refresh, every process succeeds, and
  // the credential survives.
  const pass = r.rotations === 1 && r.ok === N && r.err === 0 && Boolean(r.final);
  console.log(
    `[lock run ${i}] rotations=${r.rotations} OK=${r.ok} ERR=${r.err} ` +
      `final=${access(r.final)} -> ${pass ? "PASS" : "FAIL"}`,
  );
  if (!pass) {
    failed = true;
    r.outs.forEach((o, j) => console.log(`    child${j}: ${o}`));
  }
}

const c = await once("nolock");
console.log(
  `[nolock contrast] rotations=${c.rotations} OK=${c.ok} ERR=${c.err} ` +
    `final=${access(c.final)} (informational: pre-lock behaviour)`,
);

if (failed) {
  console.error("CONCURRENCY TEST FAILED");
  process.exit(1);
}
console.log("CONCURRENCY TEST PASSED");
