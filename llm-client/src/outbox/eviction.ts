import { unlink } from "node:fs/promises";
import type { IngestQueue } from "./queue";
import { StoppableSleep, sessionBlobPath } from "../util";

export type EvictionOpts = {
  queue: IngestQueue;
  cacheDir: string;
  now?: () => number;
  ttlMs?: number;
  isSessionPending?: (session_id: string) => boolean;
  /** Max sessions to process per pass (not records). */
  limit?: number;
};

export type EvictionSummary = {
  sessions_evicted: number;
  records_marked: number;
};

const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const DEFAULT_LIMIT = 500;

export class PendingSessionWrites {
  private counts = new Map<string, number>();

  begin(session_id: string): void {
    this.counts.set(session_id, (this.counts.get(session_id) ?? 0) + 1);
  }

  end(session_id: string): void {
    const next = (this.counts.get(session_id) ?? 0) - 1;
    if (next > 0) this.counts.set(session_id, next);
    else this.counts.delete(session_id);
  }

  has = (session_id: string): boolean => {
    return this.counts.has(session_id);
  };
}

/**
 * Run one eviction pass over the cache directory.
 *
 * The local cache file is keyed by `session_id` (shared across every
 * turn of an agent run), so eviction operates session-by-session, not
 * record-by-record. For each terminal session past TTL: unlink
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

  return evictSessions(
    opts.queue,
    opts.cacheDir,
    opts.queue.findEvictableSessions(threshold, limit),
    opts.isSessionPending,
  );
}

export type SessionCacheCleanupOpts = {
  queue: IngestQueue;
  cacheDir: string;
  session_id: string;
  isSessionPending?: (session_id: string) => boolean;
};

/**
 * Delete one session's local blob as soon as no queued record can still
 * need to upload it. This is the fast path after WebDAV PUT succeeds;
 * the periodic TTL eviction remains as a fallback for old terminal rows.
 */
export async function runSessionCacheCleanupOnce(
  opts: SessionCacheCleanupOpts,
): Promise<EvictionSummary> {
  const session = opts.queue.findReclaimableSession(opts.session_id);
  return evictSessions(
    opts.queue,
    opts.cacheDir,
    session ? [session] : [],
    opts.isSessionPending,
  );
}

async function evictSessions(
  queue: IngestQueue,
  cacheDir: string,
  sessions: Array<{ session_id: string; record_ids: string[] }>,
  isSessionPending?: (session_id: string) => boolean,
): Promise<EvictionSummary> {
  let sessions_evicted = 0;
  let records_marked = 0;
  for (const s of sessions) {
    if (isSessionPending?.(s.session_id)) continue;
    let canMarkEvicted = true;
    try {
      await unlink(sessionBlobPath(cacheDir, s.session_id));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        canMarkEvicted = false;
        console.warn(
          `unlink failed for session ${s.session_id}:`,
          (e as Error).message,
        );
      }
    }
    if (!canMarkEvicted) continue;
    for (const rid of s.record_ids) queue.markEvicted(rid);
    sessions_evicted += 1;
    records_marked += s.record_ids.length;
  }
  return { sessions_evicted, records_marked };
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
