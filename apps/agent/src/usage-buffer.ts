import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  USAGE_BATCH_PART_BUDGET_BYTES,
  usageRequestSchema,
  type UsageRequest,
  type UsagePartWire,
} from "@irori/core";

/**
 * Durable node-local usage buffer (M8, ADR-0008 §3): SQLite WAL in the agent
 * state dir. Insert on capture, delete on server ack, prune/cap-drop ordered
 * by buffer insert time. Expendable by design — never a system of record.
 *
 * IR-52: body parts live in a content-addressed `pending_parts` table (sha256
 * → gz blob, refcounted by referencing rows); `pending` rows carry only part
 * metadata + the hash list — never the bytes. Batching is budgeted on the
 * ATTACHED base64 sizes so no frame can exceed the hub's WS limit (a single
 * worst-case event fits the budget and travels alone).
 */

/** Cap on the parts store itself (gz bytes); oldest unreferenced parts evict. */
const PART_STORE_BYTES_CAP = 256 * 1024 * 1024;

export interface PendingRow {
  id: string;
  payload: string;
}

/** Part metadata as stored on a pending row (no gz — that lives in the store). */
type PartMeta = Omit<UsagePartWire, "gz">;

export class UsageBuffer {
  private readonly db: DatabaseSync;
  private readonly stmtAdd;
  private readonly stmtCount;
  private readonly stmtTake;
  private readonly stmtRemove;
  private readonly stmtRemoveHashes;
  private readonly stmtPartUpsert;
  private readonly stmtPartGet;
  private readonly stmtPartDecrement;
  private readonly stmtPartDeleteEmpty;
  private readonly stmtPartTotalBytes;
  private readonly stmtPartSweepCandidates;
  private readonly stmtQuarantineInsert;
  private readonly stmtQuarantineCount;
  private readonly stmtQuarantineExpire;
  private readonly stmtQuarantineTrim;

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
    // IR-52 migration: existing buffers gain the part-hash list column.
    const cols = this.db.prepare("PRAGMA table_info(pending)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "part_hashes")) {
      this.db.exec("ALTER TABLE pending ADD COLUMN part_hashes TEXT");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_parts (
        hash TEXT PRIMARY KEY,
        gz BLOB NOT NULL,
        bytes INTEGER NOT NULL,
        inserted_at INTEGER NOT NULL,
        refs INTEGER NOT NULL DEFAULT 0
      );
    `);
    // IR-178: oversized events park here (metadata only, no bodies/parts) —
    // visible loss, mirroring the hub's IRI-070 quarantine flow.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quarantine (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        reason TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        meta TEXT NOT NULL
      );
    `);
    this.stmtAdd = this.db.prepare("INSERT INTO pending (id, inserted_at, payload, part_hashes) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING");
    this.stmtCount = this.db.prepare("SELECT count(*) AS n FROM pending");
    this.stmtTake = this.db.prepare("SELECT id, payload, part_hashes FROM pending ORDER BY inserted_at, id LIMIT ?");
    this.stmtRemove = this.db.prepare("DELETE FROM pending WHERE id = ?");
    this.stmtRemoveHashes = this.db.prepare("SELECT part_hashes FROM pending WHERE id = ?");
    this.stmtPartUpsert = this.db.prepare(
      "INSERT INTO pending_parts (hash, gz, bytes, inserted_at, refs) VALUES (?, ?, ?, ?, 1) ON CONFLICT (hash) DO UPDATE SET refs = refs + 1",
    );
    this.stmtPartGet = this.db.prepare("SELECT gz FROM pending_parts WHERE hash = ?");
    this.stmtPartDecrement = this.db.prepare("UPDATE pending_parts SET refs = refs - 1 WHERE hash = ? AND refs > 0");
    this.stmtPartDeleteEmpty = this.db.prepare("DELETE FROM pending_parts WHERE hash = ? AND refs <= 0");
    this.stmtPartTotalBytes = this.db.prepare("SELECT coalesce(sum(length(gz)), 0) AS n FROM pending_parts");
    this.stmtPartSweepCandidates = this.db.prepare(
      "SELECT hash, length(gz) AS gzBytes FROM pending_parts WHERE refs = 0 ORDER BY inserted_at, hash",
    );
    this.stmtQuarantineInsert = this.db.prepare(
      "INSERT INTO quarantine (id, ts, reason, bytes, meta) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
    );
    this.stmtQuarantineCount = this.db.prepare("SELECT count(*) AS n FROM quarantine");
    this.stmtQuarantineExpire = this.db.prepare("DELETE FROM quarantine WHERE ts < ?");
    this.stmtQuarantineTrim = this.db.prepare(
      "DELETE FROM quarantine WHERE id IN (SELECT id FROM quarantine ORDER BY ts, id LIMIT ?)",
    );
  }

  /**
   * Durable insert; duplicate ids are a no-op — parts are never re-counted.
   * The payload stores part METADATA only (the gz bytes live once in
   * pending_parts), so the buffer does not double-store bodies. Multi-statement
   * and therefore transactional: a torn state must not leak refcounts.
   */
  add(event: UsageRequest): void {
    const metas: PartMeta[] = event.parts.map(({ gz: _gz, ...meta }) => meta);
    if (event.parts.length === 0) {
      this.stmtAdd.run(event.id, Date.now(), JSON.stringify({ ...event, parts: [] }), null);
      return;
    }
    this.transaction(() => {
      const result = this.stmtAdd.run(event.id, Date.now(), JSON.stringify({ ...event, parts: metas }), JSON.stringify(metas));
      if (result.changes === 0) return; // duplicate capture id — exactly-once
      for (const part of event.parts) {
        this.stmtPartUpsert.run(part.hash, Buffer.from(part.gz, "base64"), part.bytes, Date.now());
      }
    });
  }

  count(): number {
    const row = this.stmtCount.get() as { n: number };
    return Number(row.n);
  }

  /**
   * Oldest-first batch with gz re-attached from the parts store (rows stay
   * until remove() — crash-safe redelivery). `budgetBytes` bounds the sum of
   * SERIALIZED row sizes (base64 parts + non-part fields — the unit the wire
   * actually carries; the old math counted gz bytes, 4/3 under, and skipped
   * the first event entirely, so a count-max batch of body-heavy rows could
   * exceed the hub's frame limit). A single event over the whole budget
   * still travels alone (progress guarantee); the sync layer quarantines
   * singletons over USAGE_EVENT_HARD_CAP_BYTES (IR-178).
   */
  takeBatch(limit: number, budgetBytes = USAGE_BATCH_PART_BUDGET_BYTES): PendingRow[] {
    const rows = this.stmtTake.all(limit) as unknown as Array<PendingRow & { part_hashes: string | null }>;
    const out: PendingRow[] = [];
    let budget = budgetBytes;
    for (const row of rows) {
      let parsed: UsageRequest;
      let metas: PartMeta[] = [];
      try {
        parsed = JSON.parse(row.payload) as UsageRequest;
        metas = row.part_hashes === null ? [] : (JSON.parse(row.part_hashes) as PartMeta[]);
      } catch {
        this.remove([row.id]); // unparsable row — drop, capture never blocks
        continue;
      }
      const attached: UsagePartWire[] = [];
      let complete = true;
      for (const meta of metas) {
        const found = this.stmtPartGet.get(meta.hash) as { gz: Uint8Array } | undefined;
        if (found === undefined) {
          complete = false; // store drift — drop the row rather than send a hole
          break;
        }
        const gz = Buffer.from(found.gz);
        attached.push({ ...meta, gz: gz.toString("base64") });
      }
      if (!complete) {
        this.remove([row.id]);
        continue;
      }
      parsed.parts = attached;
      const serialized = JSON.stringify(parsed);
      const rowBytes = Buffer.byteLength(serialized);
      if (out.length > 0 && budget - rowBytes < 0) continue; // fits a later frame
      budget -= rowBytes;
      out.push({ id: row.id, payload: serialized });
    }
    return out;
  }

  remove(ids: string[]): void {
    if (ids.length === 0) return;
    this.transaction(() => {
      for (const id of ids) {
        const hashes = this.partHashesFor(id);
        this.stmtRemove.run(id);
        for (const hash of hashes) {
          this.stmtPartDecrement.run(hash);
          this.stmtPartDeleteEmpty.run(hash);
        }
      }
    });
  }

  /** Cap on parked quarantine rows so an oversized-capture bug cannot fill
   * the state dir; oldest rows expire first (with prune) and the table
   * hard-trims beyond this. */
  static readonly QUARANTINE_MAX_ROWS = 1000;

  /**
   * IR-178: parks an unsendable event with its metadata (no bodies/parts) so
   * the loss is visible and inspectable, then drops the pending row and
   * releases its part refs.
   */
  quarantine(id: string, reason: string, bytes: number, meta: Record<string, unknown>): void {
    const hashes = this.partHashesFor(id);
    this.transaction(() => {
      this.stmtQuarantineInsert.run(id, Date.now(), reason, bytes, JSON.stringify(meta));
      this.stmtRemove.run(id);
      for (const hash of hashes) {
        this.stmtPartDecrement.run(hash);
        this.stmtPartDeleteEmpty.run(hash);
      }
      const n = (this.stmtQuarantineCount.get() as { n: number }).n;
      if (n > UsageBuffer.QUARANTINE_MAX_ROWS) {
        this.stmtQuarantineTrim.run(n - UsageBuffer.QUARANTINE_MAX_ROWS);
      }
    });
  }

  quarantinedCount(): number {
    return (this.stmtQuarantineCount.get() as { n: number }).n;
  }

  private partHashesFor(id: string): string[] {
    const row = this.stmtRemoveHashes.get(id) as { part_hashes: string | null } | undefined;
    if (row === undefined || row.part_hashes === null) return [];
    try {
      const metas = JSON.parse(row.part_hashes) as PartMeta[];
      return metas.map((m) => m.hash);
    } catch {
      return [];
    }
  }

  /**
   * Drops rows older than `keepDays` (insert time, skew-immune) and caps the
   * buffer at `maxRows` (newest kept). Cap-drop may discard unacked rows —
   * accepted tradeoff under a prolonged outage. Part references are released
   * for every dropped row; the parts store itself is byte-capped, evicting
   * oldest unreferenced parts.
   */
  prune(keepDays: number, maxRows: number): void {
    this.transaction(() => {
      const ageDeleted = this.db.prepare("DELETE FROM pending WHERE inserted_at < ? RETURNING part_hashes").all(
        Date.now() - keepDays * 86_400_000,
      ) as unknown as Array<{ part_hashes: string | null }>;
      const capDeleted = this.db
        .prepare("DELETE FROM pending WHERE id NOT IN (SELECT id FROM pending ORDER BY inserted_at DESC, id DESC LIMIT ?) RETURNING part_hashes")
        .all(maxRows) as unknown as Array<{ part_hashes: string | null }>;
      for (const row of [...ageDeleted, ...capDeleted]) {
        let metas: PartMeta[] = [];
        try {
          metas = row.part_hashes === null ? [] : (JSON.parse(row.part_hashes) as PartMeta[]);
        } catch {
          metas = [];
        }
        for (const meta of metas) {
          this.stmtPartDecrement.run(meta.hash);
          this.stmtPartDeleteEmpty.run(meta.hash);
        }
      }
      this.sweepParts();
      // IR-178: quarantine rows age out with the same window as pending rows.
      this.stmtQuarantineExpire.run(Date.now() - keepDays * 86_400_000);
    });
  }

  /** BEGIN IMMEDIATE … COMMIT/ROLLBACK around a multi-statement mutation. */
  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Evicts oldest unreferenced parts until the store is under its byte cap. */
  private sweepParts(): void {
    const total = this.stmtPartTotalBytes.get() as { n: number };
    let bytes = Number(total.n);
    if (bytes <= PART_STORE_BYTES_CAP) return;
    const candidates = this.stmtPartSweepCandidates.all() as unknown as Array<{ hash: string; gzBytes: number }>;
    const drop: string[] = [];
    for (const candidate of candidates) {
      if (bytes <= PART_STORE_BYTES_CAP) break;
      drop.push(candidate.hash);
      bytes -= Number(candidate.gzBytes);
    }
    for (const hash of drop) this.db.prepare("DELETE FROM pending_parts WHERE hash = ?").run(hash);
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
