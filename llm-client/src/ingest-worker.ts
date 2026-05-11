import type { IngestQueue, RecordState } from "./queue";
import type { IngestBody } from "./ingest";

export const DEFAULT_BACKOFF: number[] = [
  1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000, 60 * 60_000,
];

export function nextBackoff(
  attempts: number,
  schedule: number[] = DEFAULT_BACKOFF,
): number {
  const i = Math.min(attempts, schedule.length - 1);
  return schedule[i] ?? schedule[schedule.length - 1]!;
}

/**
 * Uniform return shape from each stage handler. The worker translates this
 * into a queue transition, so handlers don't need to know about queue state.
 */
export type StageResult =
  | { kind: "advance" }
  | { kind: "retry"; reason: string }
  | { kind: "terminal"; finalState: "conflict" | "fatal"; reason: string };

export type StageHandler = (body: IngestBody) => Promise<StageResult>;

export type Stages = {
  ingest: StageHandler;   // called on state=captured
  sync: StageHandler;     // called on state=ingested
  confirm: StageHandler;  // called on state=synced
};

export type WorkerOpts = {
  queue: IngestQueue;
  stages: Stages;
  now?: () => number;
  backoff?: number[];
  concurrency?: number;
};

export type RunSummary = {
  processed: number;
  advance: number;
  retry: number;
  terminal: number;
};

function stageFor(state: RecordState, stages: Stages): StageHandler | undefined {
  switch (state) {
    case "captured": return stages.ingest;
    case "ingested": return stages.sync;
    case "synced":   return stages.confirm;
    default:         return undefined;
  }
}

function nextStateAfter(state: RecordState): RecordState {
  switch (state) {
    case "captured": return "ingested";
    case "ingested": return "synced";
    case "synced":   return "done";
    default:         return state;
  }
}

export async function runOnce(
  opts: WorkerOpts,
  limit = 50,
): Promise<RunSummary> {
  const now = (opts.now ?? Date.now)();
  const concurrency = opts.concurrency ?? 4;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;

  const ready = opts.queue.pickReady(now, limit);

  const summary: RunSummary = {
    processed: ready.length,
    advance: 0,
    retry: 0,
    terminal: 0,
  };

  // Bound concurrency. Records inside the batch run in parallel up to `concurrency`.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, ready.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= ready.length) return;
      const slot = ready[i]!;
      const handler = stageFor(slot.state, opts.stages);
      if (!handler) continue;
      let result: StageResult;
      try {
        result = await handler(slot.body);
      } catch (e) {
        result = { kind: "retry", reason: (e as Error).message ?? "handler threw" };
      }
      applyResult(opts.queue, slot.body.record_id, slot.state, result, now, backoff);
      if (result.kind === "advance") summary.advance += 1;
      else if (result.kind === "retry") summary.retry += 1;
      else summary.terminal += 1;
    }
  });
  await Promise.all(workers);

  return summary;
}

function applyResult(
  queue: IngestQueue,
  recordId: string,
  currentState: RecordState,
  result: StageResult,
  now: number,
  backoff: number[],
): void {
  switch (result.kind) {
    case "advance": {
      queue.advance(recordId, nextStateAfter(currentState), now);
      break;
    }
    case "retry": {
      const attempts = queue.statusOf(recordId)?.attempts ?? 0;
      queue.markRetry(recordId, result.reason, now + nextBackoff(attempts, backoff));
      break;
    }
    case "terminal": {
      queue.markTerminal(recordId, result.finalState, result.reason);
      break;
    }
  }
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
        console.error("worker tick failed:", (e as Error).message);
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
