import { Database } from "bun:sqlite";
import type { IngestBody } from "./ingest";

/**
 * Per-record lifecycle.
 *
 *   captured -> ingested -> synced -> done
 *
 * At each non-terminal state the worker performs ONE action:
 *   captured   : POST /ingest/context
 *   ingested   : WebDAV PUT blob to Tbox
 *   synced     : POST /ingest/context/{id}/uploaded
 *
 * Terminal failures:
 *   conflict   : ingest got 409 (body mismatch)
 *   fatal      : non-retryable 4xx (auth, schema, etc.)
 */
export type RecordState =
  | "captured"
  | "ingested"
  | "synced"
  | "done"
  | "conflict"
  | "fatal";

export const ACTIVE_STATES: RecordState[] = ["captured", "ingested", "synced"];

export type QueueStatus = {
  record_id: string;
  state: RecordState;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
};

export type ReadyRecord = {
  body: IngestBody;
  state: RecordState;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS outbox (
    record_id        TEXT PRIMARY KEY,
    body_json        TEXT NOT NULL,
    state            TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER NOT NULL,
    last_error       TEXT,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_outbox_active
    ON outbox (state, next_attempt_at);
`;

export class IngestQueue {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  enqueue(body: IngestBody, nextAttemptAt: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox
           (record_id, body_json, state, attempts, next_attempt_at, created_at)
         VALUES (?, ?, 'captured', 0, ?, ?)`,
      )
      .run(body.record_id, JSON.stringify(body), nextAttemptAt, Date.now());
  }

  pickReady(now: number, limit: number): ReadyRecord[] {
    const placeholders = ACTIVE_STATES.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT body_json, state FROM outbox
         WHERE state IN (${placeholders}) AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT ?`,
      )
      .all(...ACTIVE_STATES, now, limit) as Array<{ body_json: string; state: RecordState }>;
    return rows.map((r) => ({
      body: JSON.parse(r.body_json) as IngestBody,
      state: r.state,
    }));
  }

  /**
   * Advance to the next state on success. Resets attempts + clears error.
   */
  advance(record_id: string, newState: RecordState, nextAttemptAt: number): void {
    this.db
      .prepare(
        `UPDATE outbox
         SET state = ?, attempts = 0, next_attempt_at = ?, last_error = NULL
         WHERE record_id = ?`,
      )
      .run(newState, nextAttemptAt, record_id);
  }

  /**
   * Retry the current stage. Increments attempts, sets next_attempt_at,
   * records error. State unchanged.
   */
  markRetry(record_id: string, error: string, nextAttemptAt: number): void {
    this.db
      .prepare(
        `UPDATE outbox
         SET attempts = attempts + 1,
             next_attempt_at = ?,
             last_error = ?
         WHERE record_id = ?`,
      )
      .run(nextAttemptAt, error, record_id);
  }

  /**
   * Terminal failure (conflict | fatal). No further work attempted.
   */
  markTerminal(
    record_id: string,
    finalState: "conflict" | "fatal",
    error: string,
  ): void {
    this.db
      .prepare(
        `UPDATE outbox
         SET state = ?, last_error = ?
         WHERE record_id = ?`,
      )
      .run(finalState, error, record_id);
  }

  statusOf(record_id: string): QueueStatus | undefined {
    const row = this.db
      .prepare(
        `SELECT record_id, state, attempts, next_attempt_at, last_error
         FROM outbox WHERE record_id = ?`,
      )
      .get(record_id) as QueueStatus | null;
    return row ?? undefined;
  }

  close(): void {
    this.db.close();
  }
}
