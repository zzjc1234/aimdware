import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { IngestQueue } from "./queue";
import { StoppableSleep } from "./util";

export type EvictionOpts = {
  queue: IngestQueue;
  cacheDir: string;
  now?: () => number;
  ttlMs?: number;
  limit?: number;
};

export type EvictionSummary = {
  evicted: number;
};

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_LIMIT = 500;

/**
 * Run one eviction pass. Deletes `records/{id}.json` for done records
 * older than `ttlMs`, then marks the queue row as `cache_evicted = 1`.
 * Idempotent: a missing file still gets the row marked.
 *
 * The queue row itself is never deleted — it remains as a local audit
 * trail. Eventual queue cleanup is a separate admin concern.
 */
export async function runEvictionOnce(
  opts: EvictionOpts,
): Promise<EvictionSummary> {
  const now = (opts.now ?? Date.now)();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const threshold = now - ttlMs;

  const ids = opts.queue.findEvictable(threshold, limit);
  for (const id of ids) {
    try {
      await unlink(join(opts.cacheDir, "records", `${id}.json`));
    } catch (e) {
      // ENOENT etc. — file already gone, still consider it evicted.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(`unlink failed for ${id}:`, (e as Error).message);
      }
    }
    opts.queue.markEvicted(id);
  }
  return { evicted: ids.length };
}

export type EvictionLoopHandle = { stop: () => Promise<void> };

export function startEvictionLoop(
  opts: EvictionOpts,
  pollMs = 30 * 60 * 1000, // every 30 minutes
): EvictionLoopHandle {
  const sleeper = new StoppableSleep();
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      try {
        await runEvictionOnce(opts);
      } catch (e) {
        console.error("eviction tick failed:", (e as Error).message);
      }
      if (stopped) break;
      await sleeper.sleep(pollMs);
    }
  })();
  return {
    async stop() {
      stopped = true;
      sleeper.stop();
      await done;
    },
  };
}
