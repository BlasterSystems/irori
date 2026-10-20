import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { usageRequestSchema, type UsageRequest } from "@irori/core";

/**
 * Durable node-local usage buffer (M8, ADR-0008 §3): SQLite WAL in the agent
 * state dir. Insert on capture, delete on server ack, prune/cap-drop ordered
 * by buffer insert time. Expendable by design — never a system of record.
 */

export interface PendingRow {
  id: string;
  payload: string;
}

export class UsageBuffer {
  private readonly db: DatabaseSync;
  private readonly stmtAdd;
  private readonly stmtCount;
  private readonly stmtTake;
  private readonly stmtRemove;
  private readonly stmtPruneAge;
  private readonly stmtPruneCap;

  constructor(stateDir: string, fileName = "usage-buffer.db") {
    mkdirSync(stateDir, { recursive: true });
    this.db = new DatabaseSync(join(stateDir, fileName));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending (
        id TEXT PRIMARY KEY,
        inserted_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS pending_inserted_idx ON pending(inserted_at)");
    this.stmtAdd = this.db.prepare("INSERT INTO pending (id, inserted_at, payload) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING");
    this.stmtCount = this.db.prepare("SELECT count(*) AS n FROM pending");
    this.stmtTake = this.db.prepare("SELECT id, payload FROM pending ORDER BY inserted_at, id LIMIT ?");
    this.stmtRemove = this.db.prepare("DELETE FROM pending WHERE id = ?");
    this.stmtPruneAge = this.db.prepare("DELETE FROM pending WHERE inserted_at < ?");
    this.stmtPruneCap = this.db.prepare(
      "DELETE FROM pending WHERE id NOT IN (SELECT id FROM pending ORDER BY inserted_at DESC, id DESC LIMIT ?)",
    );
  }

  /** Durable insert; duplicate ids are a no-op (exactly-once end to end). */
  add(event: UsageRequest): void {
    this.stmtAdd.run(event.id, Date.now(), JSON.stringify(event));
  }

  count(): number {
    const row = this.stmtCount.get() as { n: number };
    return Number(row.n);
  }

  /** Oldest-first batch (rows stay until remove() — crash-safe redelivery). */
  takeBatch(limit: number): PendingRow[] {
    return this.stmtTake.all(limit) as unknown as PendingRow[];
  }

  remove(ids: string[]): void {
    for (const id of ids) this.stmtRemove.run(id);
  }

  /**
   * Drops rows older than `keepDays` (insert time, skew-immune) and caps the
   * buffer at `maxRows` (newest kept). Cap-drop may discard unacked rows —
   * accepted tradeoff under a prolonged outage.
   */
  prune(keepDays: number, maxRows: number): void {
    this.stmtPruneAge.run(Date.now() - keepDays * 86_400_000);
    this.stmtPruneCap.run(maxRows);
  }

  close(): void {
    this.db.close();
  }
}

/** Parses a buffered payload back into a validated request (or null). */
export function parsePending(row: PendingRow): UsageRequest | null {
  try {
    const parsed = usageRequestSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
