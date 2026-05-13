import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { IngestQueue } from "./queue";
import { StoppableSleep } from "./util";

export type EvictionOpts = {
  queue: IngestQueue;
  cacheDir: string;
  now?: () => number;
  ttlMs?: number;
  /** Max sessions to process per pass (not records). */
  limit?: number;
};

export type EvictionSummary = {
  sessions_evicted: number;
  records_marked: number;
};

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_LIMIT = 500;

/**
 * Run one eviction pass over the cache directory.
 *
 * The local cache file is keyed by `session_id` (shared across every
 * turn of an agent run), so eviction operates session-by-session, not
 * record-by-record. For each settled session past TTL: unlink
 * `records/<session_id>.json` once and mark every constituent record
 * `cache_evicted = 1`. ENOENT is tolerated (the file may have been
 * cleared out-of-band).
 *
 * The queue rows themselves are never deleted — they remain as a local
 * audit trail. Eventual queue cleanup is a separate admin concern.
 */
export async function runEvictionOnce(
  opts: EvictionOpts,
): Promise<EvictionSummary> {
  const now = (opts.now ?? Date.now)();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const threshold = now - ttlMs;

  const sessions = opts.queue.findEvictableSessions(threshold, limit);
  let records_marked = 0;
  for (const s of sessions) {
    try {
      await unlink(join(opts.cacheDir, "records", `${s.session_id}.json`));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(
          `unlink failed for session ${s.session_id}:`,
          (e as Error).message,
        );
      }
    }
    for (const rid of s.record_ids) opts.queue.markEvicted(rid);
    records_marked += s.record_ids.length;
  }
  return { sessions_evicted: sessions.length, records_marked };
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
