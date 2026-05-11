import type { IngestQueue } from "./queue";
import {
  postContext,
  type IngestBody,
  type PostContextOpts,
  type PostContextResult,
} from "./ingest";

export const DEFAULT_BACKOFF: number[] = [
  1_000,        // attempt 1: 1s
  5_000,        // attempt 2: 5s
  30_000,       // attempt 3: 30s
  5 * 60_000,   // attempt 4: 5m
  30 * 60_000,  // attempt 5: 30m
  60 * 60_000,  // attempt 6+: 1h (cap)
];

export function nextBackoff(
  attempts: number,
  schedule: number[] = DEFAULT_BACKOFF,
): number {
  const i = Math.min(attempts, schedule.length - 1);
  return schedule[i] ?? schedule[schedule.length - 1]!;
}

export type PostContextImpl = (
  backendUrl: string,
  studentToken: string,
  body: IngestBody,
  opts?: PostContextOpts,
) => Promise<PostContextResult>;

export type WorkerOpts = {
  queue: IngestQueue;
  backendUrl: string;
  studentToken: string;
  now?: () => number;
  postContextImpl?: PostContextImpl;
  backoff?: number[];
};

export type RunSummary = {
  processed: number;
  created: number;
  exists: number;
  conflict: number;
  fatal: number;
  retry: number;
};

export async function runOnce(
  opts: WorkerOpts,
  limit = 50,
): Promise<RunSummary> {
  const now = (opts.now ?? Date.now)();
  const post: PostContextImpl = opts.postContextImpl ?? postContext;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;

  const ready = opts.queue.pickReady(now, limit);
  const summary: RunSummary = {
    processed: 0,
    created: 0,
    exists: 0,
    conflict: 0,
    fatal: 0,
    retry: 0,
  };

  for (const body of ready) {
    summary.processed += 1;
    const result = await post(opts.backendUrl, opts.studentToken, body);
    switch (result.kind) {
      case "created":
        opts.queue.markSent(body.record_id, "created");
        summary.created += 1;
        break;
      case "exists":
        opts.queue.markSent(body.record_id, "exists");
        summary.exists += 1;
        break;
      case "conflict":
        opts.queue.markTerminal(body.record_id, "conflict", "body mismatch");
        summary.conflict += 1;
        break;
      case "fatal":
        opts.queue.markTerminal(
          body.record_id,
          "fatal",
          `status=${result.status}: ${result.reason}`,
        );
        summary.fatal += 1;
        break;
      case "retryable": {
        const prev = opts.queue.statusOf(body.record_id);
        const attempts = prev?.attempts ?? 0;
        const delay = nextBackoff(attempts, backoff);
        opts.queue.markRetry(body.record_id, result.reason, now + delay);
        summary.retry += 1;
        break;
      }
    }
  }

  return summary;
}

export type WorkerLoopHandle = { stop: () => Promise<void> };

export function startWorkerLoop(
  opts: WorkerOpts,
  pollMs = 1000,
): WorkerLoopHandle {
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      try {
        await runOnce(opts);
      } catch (e) {
        console.error("ingest worker tick failed:", (e as Error).message);
      }
      await Bun.sleep(pollMs);
    }
  })();

  return {
    async stop() {
      stopped = true;
      await done;
    },
  };
}
