import { Database } from "bun:sqlite";
import type { IngestBody } from "./ingest-client";

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
  claimed_at: number | null;
};

export type ReadyRecord = {
  body: IngestBody;
  state: RecordState;
};

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS outbox (
    record_id        TEXT PRIMARY KEY,
    session_id       TEXT,
    body_json        TEXT NOT NULL,
    state            TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER NOT NULL,
    last_error       TEXT,
    created_at       INTEGER NOT NULL,
    cache_evicted    INTEGER NOT NULL DEFAULT 0,
    claimed_at       INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS ix_outbox_active
    ON outbox (state, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS ix_outbox_evictable
    ON outbox (state, cache_evicted, created_at)`,
  // NOTE: ix_outbox_session is intentionally NOT here — it references
  // session_id, which may not exist on a legacy DB. The migrateSchema()
  // step creates the column (idempotently) and then the index.
];

export class IngestQueue {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL");
    // Block up to 5s waiting on another writer instead of failing with SQLITE_BUSY.
    // Matters when multiple router processes share one outbox file.
    this.db.run("PRAGMA busy_timeout = 5000");
    for (const sql of SCHEMA_STATEMENTS) this.db.run(sql);
    // Migration step must run AFTER the base schema exists but BEFORE
    // any DDL that depends on added columns (e.g. ix_outbox_session).
    this.migrateSchema();
  }

  /**
   * Idempotently add columns + indexes missing on older databases.
   * ALTER TABLE ADD COLUMN throws on duplicate, so we probe first via PRAGMA.
   */
  private migrateSchema(): void {
    const cols = this.db.prepare("PRAGMA table_info(outbox)").all() as Array<{
      name: string;
    }>;
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has("session_id")) {
      this.db.run("ALTER TABLE outbox ADD COLUMN session_id TEXT");
    }
    // CREATE INDEX IF NOT EXISTS is safe on both legacy and fresh DBs
    // — by this point session_id is guaranteed to exist.
    this.db.run(
      "CREATE INDEX IF NOT EXISTS ix_outbox_session ON outbox (session_id)",
    );
  }

  enqueue(body: IngestBody, nextAttemptAt: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox
           (record_id, session_id, body_json, state, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 'captured', 0, ?, ?)`,
      )
      .run(
        body.record_id,
        body.session_id,
        JSON.stringify(body),
        nextAttemptAt,
        Date.now(),
      );
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
      .all(...ACTIVE_STATES, now, limit) as Array<{
      body_json: string;
      state: RecordState;
    }>;
    return rows.map((r) => ({
      body: JSON.parse(r.body_json) as IngestBody,
      state: r.state,
    }));
  }

  /**
   * Atomically claim up to `limit` ready records and mark them as
   * `claimed_at = now`. Returns the claimed batch.
   *
   * A row is "ready" when:
   *   - state is one of ACTIVE_STATES
   *   - next_attempt_at <= now
   *   - claimed_at is null OR older than `staleMs` (worker holding the
   *     claim is presumed dead)
   *
   * Implementation is a single UPDATE ... RETURNING so two concurrent
   * workers (across processes on the same sqlite file) never see the
   * same record.
   */
  claim(now: number, limit: number, staleMs = 60_000): ReadyRecord[] {
    const placeholders = ACTIVE_STATES.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        // The ORDER BY in the subquery influences which rows the UPDATE
        // grabs, even though SQLite doesn't otherwise honour ORDER inside
        // an IN clause. Kept for fairness across processes.
        `UPDATE outbox
         SET claimed_at = ?
         WHERE record_id IN (
           SELECT record_id FROM outbox
           WHERE state IN (${placeholders})
             AND next_attempt_at <= ?
             AND (claimed_at IS NULL OR claimed_at < ?)
           ORDER BY next_attempt_at ASC, created_at ASC
           LIMIT ?
         )
         RETURNING body_json, state`,
      )
      .all(now, ...ACTIVE_STATES, now, now - staleMs, limit) as Array<{
      body_json: string;
      state: RecordState;
    }>;
    return rows.map((r) => ({
      body: JSON.parse(r.body_json) as IngestBody,
      state: r.state,
    }));
  }

  /**
   * Advance to the next state on success. Resets attempts + clears error.
   */
  advance(
    record_id: string,
    newState: RecordState,
    nextAttemptAt: number,
  ): void {
    this.db
      .prepare(
        `UPDATE outbox
         SET state = ?, attempts = 0, next_attempt_at = ?,
             last_error = NULL, claimed_at = NULL
         WHERE record_id = ?`,
      )
      .run(newState, nextAttemptAt, record_id);
  }

  /**
   * Retry the current stage. Increments attempts, sets next_attempt_at,
   * records error. State unchanged. Claim is released so another worker
   * can pick the record up on its next tick.
   */
  markRetry(record_id: string, error: string, nextAttemptAt: number): void {
    this.db
      .prepare(
        `UPDATE outbox
         SET attempts = attempts + 1,
             next_attempt_at = ?,
             last_error = ?,
             claimed_at = NULL
         WHERE record_id = ?`,
      )
      .run(nextAttemptAt, error, record_id);
  }

  /** Mark a terminal failure (conflict | fatal). No further work attempted. */
  markTerminal(
    record_id: string,
    finalState: "conflict" | "fatal",
    error: string,
  ): void {
    this.db
      .prepare(
        `UPDATE outbox
         SET state = ?, last_error = ?, claimed_at = NULL
         WHERE record_id = ?`,
      )
      .run(finalState, error, record_id);
  }

  statusOf(record_id: string): QueueStatus | undefined {
    const row = this.db
      .prepare(
        `SELECT record_id, state, attempts, next_attempt_at, last_error, claimed_at
         FROM outbox WHERE record_id = ?`,
      )
      .get(record_id) as QueueStatus | null;
    return row ?? undefined;
  }

  /**
   * Return sessions whose on-disk cache file is safe to delete. A session
   * is evictable when:
   *
   *   - every record in the session is terminal: done, conflict, or fatal
   *     (no in-flight turns that still need to read the file)
   *   - at least one record still has cache_evicted=0 (otherwise this
   *     session has already been processed)
   *   - MAX(created_at) across the session's records is older than the
   *     threshold (the session is "settled")
   *
   * Capped by `limit` SESSIONS (not records). Oldest sessions first.
   */
  findEvictableSessions(
    olderThanCreatedAt: number,
    limit: number,
  ): Array<{ session_id: string; record_ids: string[] }> {
    // Separator = ASCII unit separator (0x1F). Can't appear in a UUID
    // record_id, so the split back is safe even if the id format changes.
    const SEP = "\x1f";
    const rows = this.db
      .prepare(
        `SELECT session_id, group_concat(record_id, '${SEP}') AS record_ids
         FROM outbox
         WHERE session_id IS NOT NULL
         GROUP BY session_id
         HAVING SUM(CASE WHEN state IN ('done', 'conflict', 'fatal') THEN 0 ELSE 1 END) = 0
            AND SUM(CASE WHEN cache_evicted = 0 THEN 1 ELSE 0 END) > 0
            AND MAX(created_at) < ?
         ORDER BY MAX(created_at) ASC
         LIMIT ?`,
      )
      .all(olderThanCreatedAt, limit) as Array<{
      session_id: string;
      record_ids: string;
    }>;
    return rows.map((r) => ({
      session_id: r.session_id,
      record_ids: r.record_ids.split(SEP),
    }));
  }

  markEvicted(record_id: string): void {
    this.db
      .prepare(`UPDATE outbox SET cache_evicted = 1 WHERE record_id = ?`)
      .run(record_id);
  }

  /** Check whether the cache file for this record has been freed. */
  isEvicted(record_id: string): boolean {
    const row = this.db
      .prepare(`SELECT cache_evicted FROM outbox WHERE record_id = ?`)
      .get(record_id) as { cache_evicted: number } | null;
    return row?.cache_evicted === 1;
  }

  close(): void {
    this.db.close();
  }
}
