import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { usageRequestSchema, type UsageRequest, type UsagePartWire } from "@irori/core";

/**
 * Durable node-local usage buffer (M8, ADR-0008 §3): SQLite WAL in the agent
 * state dir. Insert on capture, delete on server ack, prune/cap-drop ordered
 * by buffer insert time. Expendable by design — never a system of record.
 *
 * IR-52: body parts live in a content-addressed `pending_parts` table (sha256
 * → gz blob, refcounted by referencing rows); `pending` rows carry only part
 * metadata + the hash list. Batching is byte-budgeted so one frame stays
 * bounded no matter how large retained bodies are.
 */

/** Max sum of ORIGINAL part bytes attached to one upload frame. */
export const USAGE_BATCH_PART_BUDGET_BYTES = 24 * 1024 * 1024;

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
  }

  /** Durable insert; duplicate ids are a no-op — parts are never re-counted. */
  add(event: UsageRequest): void {
    if (event.parts.length === 0) {
      this.stmtAdd.run(event.id, Date.now(), JSON.stringify(event), null);
      return;
    }
    const metas: PartMeta[] = event.parts.map(({ gz: _gz, ...meta }) => meta);
    const result = this.stmtAdd.run(event.id, Date.now(), JSON.stringify(event), JSON.stringify(metas));
    if (result.changes === 0) return; // duplicate capture id — exactly-once
    for (const part of event.parts) {
      this.stmtPartUpsert.run(part.hash, Buffer.from(part.gz, "base64"), part.bytes, Date.now());
    }
  }

  count(): number {
    const row = this.stmtCount.get() as { n: number };
    return Number(row.n);
  }

  /**
   * Oldest-first batch with gz re-attached from the parts store (rows stay
   * until remove() — crash-safe redelivery). `partBudgetBytes` bounds the sum
   * of original part bytes attached to the frame; an event whose first part
   * already exceeds the budget still travels alone (progress guarantee).
   */
  takeBatch(limit: number, partBudgetBytes = USAGE_BATCH_PART_BUDGET_BYTES): PendingRow[] {
    const rows = this.stmtTake.all(limit) as unknown as Array<PendingRow & { part_hashes: string | null }>;
    const out: PendingRow[] = [];
    let budget = partBudgetBytes;
    for (const row of rows) {
      let event: UsageRequest;
      try {
        event = JSON.parse(row.payload) as UsageRequest;
      } catch {
        this.remove([row.id]); // unparsable row — drop, capture never blocks
        continue;
      }
      let metas: PartMeta[] = [];
      try {
        metas = row.part_hashes === null ? [] : (JSON.parse(row.part_hashes) as PartMeta[]);
      } catch {
        metas = [];
      }
      const attached: UsagePartWire[] = [];
      let eventBytes = 0;
      let complete = true;
      for (const meta of metas) {
        const found = this.stmtPartGet.get(meta.hash) as { gz: Uint8Array } | undefined;
        if (found === undefined) {
          complete = false; // store drift — drop the row rather than send a hole
          break;
        }
        attached.push({ ...meta, gz: Buffer.from(found.gz).toString("base64") });
        eventBytes += meta.bytes;
      }
      if (!complete) {
        this.remove([row.id]);
        continue;
      }
      if (out.length > 0 && budget - eventBytes < 0) continue; // fits a later frame
      budget -= eventBytes;
      event.parts = attached;
      out.push({ id: row.id, payload: JSON.stringify(event) });
    }
    return out;
  }

  remove(ids: string[]): void {
    for (const id of ids) {
      const hashes = this.partHashesFor(id);
      this.stmtRemove.run(id);
      for (const hash of hashes) {
        this.stmtPartDecrement.run(hash);
        this.stmtPartDeleteEmpty.run(hash);
      }
    }
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
