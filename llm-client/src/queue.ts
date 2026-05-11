import { Database } from "bun:sqlite";
import type { IngestBody } from "./ingest";

export type QueueState = "pending" | "sent" | "conflict" | "fatal";

export type QueueStatus = {
  record_id: string;
  state: QueueState;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ingest_queue (
    record_id        TEXT PRIMARY KEY,
    body_json        TEXT NOT NULL,
    state            TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER NOT NULL,
    last_error       TEXT,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_pending_ready
    ON ingest_queue (state, next_attempt_at);
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
        `INSERT OR IGNORE INTO ingest_queue
           (record_id, body_json, state, attempts, next_attempt_at, created_at)
         VALUES (?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        body.record_id,
        JSON.stringify(body),
        nextAttemptAt,
        Date.now(),
      );
  }

  pickReady(now: number, limit: number): IngestBody[] {
    const rows = this.db
      .prepare(
        `SELECT body_json FROM ingest_queue
         WHERE state = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as { body_json: string }[];
    return rows.map((r) => JSON.parse(r.body_json) as IngestBody);
  }

  markSent(record_id: string, _kind: "created" | "exists"): void {
    this.db
      .prepare(
        `UPDATE ingest_queue SET state = 'sent', last_error = NULL
         WHERE record_id = ?`,
      )
      .run(record_id);
  }

  markRetry(record_id: string, error: string, nextAttemptAt: number): void {
    this.db
      .prepare(
        `UPDATE ingest_queue
         SET attempts = attempts + 1,
             next_attempt_at = ?,
             last_error = ?
         WHERE record_id = ?`,
      )
      .run(nextAttemptAt, error, record_id);
  }

  markTerminal(
    record_id: string,
    finalState: "conflict" | "fatal",
    error: string,
  ): void {
    this.db
      .prepare(
        `UPDATE ingest_queue
         SET state = ?, last_error = ?
         WHERE record_id = ?`,
      )
      .run(finalState, error, record_id);
  }

  statusOf(record_id: string): QueueStatus | undefined {
    const row = this.db
      .prepare(
        `SELECT record_id, state, attempts, next_attempt_at, last_error
         FROM ingest_queue WHERE record_id = ?`,
      )
      .get(record_id) as QueueStatus | null;
    return row ?? undefined;
  }

  close(): void {
    this.db.close();
  }
}
