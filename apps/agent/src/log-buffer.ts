import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { logEventSchema, type LogEvent } from "@irori/core";

/**
 * Durable node-local log buffer (IRI-078): SQLite WAL in the agent state
 * dir, the same shape as the usage buffer (ADR-0008 §3). The driver pushes
 * lines into a bounded in-memory queue — NEVER blocks on I/O — and this
 * buffer is written behind it, so an offline node keeps its lines on disk
 * and replays them on reconnect. Cap-drop (oldest first) is counted: the
 * hub shows truncation instead of hiding it.
 */

/** Rows kept before drop-oldest (a flooding engine cannot grow the file). */
export const LOG_BUFFER_MAX_ROWS = 50_000;

export class LogBuffer {
  private readonly db: DatabaseSync;
  private readonly stmtAdd;
  private readonly stmtCount;
  private readonly stmtTake;
  private readonly stmtRemove;
  private readonly stmtDropOldest;
  private readonly stmtCountDropped;

  constructor(stateDir: string, fileName = "logs-buffer.db") {
    mkdirSync(stateDir, { recursive: true });
    this.db = new DatabaseSync(join(stateDir, fileName));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending (
        rowid_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        inserted_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS pending_inserted_idx ON pending(inserted_at)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS drop_counters (
        key TEXT PRIMARY KEY,
        dropped INTEGER NOT NULL DEFAULT 0,
        last_drop_at INTEGER
      );
    `);
    this.stmtAdd = this.db.prepare("INSERT INTO pending (id, inserted_at, payload) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING");
    this.stmtCount = this.db.prepare("SELECT count(*) AS n FROM pending");
    this.stmtTake = this.db.prepare("SELECT id, payload FROM pending ORDER BY rowid_seq LIMIT ?");
    this.stmtRemove = this.db.prepare("DELETE FROM pending WHERE id = ?");
    this.stmtDropOldest = this.db.prepare(
      "DELETE FROM pending WHERE id IN (SELECT id FROM pending ORDER BY rowid_seq LIMIT ?)",
    );
    this.stmtCountDropped = this.db.prepare("SELECT dropped FROM drop_counters WHERE key = 'agent'");
  }

  /** Durable insert + cap enforcement, one transaction. Duplicate ids (a
   *  replayed emit) are a no-op and never re-count toward the cap. */
  add(event: LogEvent, maxRows = LOG_BUFFER_MAX_ROWS): void {
    this.db.exec("BEGIN");
    try {
      const result = this.stmtAdd.run(event.eventId, Date.now(), JSON.stringify(event));
      if (result.changes > 0) {
        const overflow = this.count() - maxRows;
        if (overflow > 0) {
          const del = this.stmtDropOldest.run(overflow);
          if (del.changes > 0) this.bumpDropped(Number(del.changes));
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* nothing else to do */
      }
      throw err;
    }
  }

  count(): number {
    const row = this.stmtCount.get() as { n: number | bigint };
    return Number(row.n);
  }

  /** Cumulative queue-overflow drops (reported to the hub as truncation). */
  droppedTotal(): number {
    const row = this.stmtCountDropped.get() as { dropped: number | bigint } | undefined;
    return row === undefined ? 0 : Number(row.dropped);
  }

  private bumpDropped(n: number): void {
    this.db
      .prepare(
        `INSERT INTO drop_counters (key, dropped, last_drop_at) VALUES ('agent', ?, ?)
         ON CONFLICT (key) DO UPDATE SET dropped = dropped + excluded.dropped, last_drop_at = excluded.last_drop_at`,
      )
      .run(n, Date.now());
  }

  /** Oldest-first batch; rows stay until remove() (crash-safe redelivery —
   *  the hub dedupes by event id). */
  takeBatch(limit: number): Array<{ id: string; payload: string }> {
    return this.stmtTake.all(limit) as Array<{ id: string; payload: string }>;
  }

  remove(ids: string[]): void {
    this.db.exec("BEGIN");
    try {
      for (const id of ids) this.stmtRemove.run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* nothing else to do */
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Parses a buffered row back into a validated event (or null on drift). */
export function parsePendingLog(row: { payload: string }): LogEvent | null {
  try {
    const parsed = logEventSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
