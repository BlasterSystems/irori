import { eq, sql } from "drizzle-orm";
import { llmSnapshots, settings, tokenLedger } from "@irori/db";
import type { Db } from "@irori/db";
import type { Granularity } from "./rollups.js";

/**
 * Token ledger (M7, SPEC §9): diffs the probes' cumulative token counters
 * per (node, port) into hourly/daily deltas attributed to the detected
 * model. State (last seen llm snapshot id + per-port counter baselines)
 * lives in the settings table — deltas are consumed exactly once, so the
 * pass is idempotent under re-runs and safe to run every 60 s.
 *
 * Counter resets (engine restart: value decreases) re-baseline and
 * contribute nothing — the ledger never invents negative tokens. Buckets
 * are keyed on SERVER receive time like every other rollup.
 */
export const TOKEN_LEDGER_STATE_KEY = "token_ledger_state";

const BATCH = 2000;

interface CounterState {
  lastId: number;
  /** "nodeId:port" → last seen cumulative counters. */
  counters: Record<string, { g: number | null; p: number | null; c: number | null }>;
}

interface LedgerDelta {
  nodeId: string;
  port: number;
  model: string;
  granularity: "hour" | "day";
  bucketStart: string;
  dGen: number;
  dPrompt: number;
  dCached: number;
  sawGen: boolean;
  sawPrompt: boolean;
  sawCached: boolean;
}

function floorIso(t: Date, granularity: Granularity): string {
  const ms = granularity === "hour" ? 3_600_000 : 86_400_000;
  return new Date(Math.floor(t.getTime() / ms) * ms).toISOString();
}

function readState(raw: unknown): CounterState {
  if (typeof raw === "object" && raw !== null && typeof (raw as { lastId?: unknown }).lastId === "number") {
    const r = raw as { lastId: number; counters?: unknown };
    return { lastId: r.lastId, counters: typeof r.counters === "object" && r.counters !== null ? (r.counters as CounterState["counters"]) : {} };
  }
  return { lastId: 0, counters: {} };
}

/** Delta against the previous counter, reset-safe (decrease → 0, re-baseline). */
function delta(prev: number | null, next: number | null): { d: number; saw: boolean } {
  if (next === null) return { d: 0, saw: false };
  if (prev === null) return { d: 0, saw: true }; // first sighting: baseline only
  if (next < prev) return { d: 0, saw: true }; // counter reset (engine restart)
  return { d: next - prev, saw: true };
}

export interface TokenLedgerEngine {
  runOnce(now?: Date): Promise<void>;
}

export function createTokenLedgerEngine(db: Db): TokenLedgerEngine {
  return {
    async runOnce(_now = new Date()): Promise<void> {
      const [stateRow] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, TOKEN_LEDGER_STATE_KEY));
      const state = readState(stateRow?.value);
      let total = 0;

      for (;;) {
        const rows = await db
          .select({ id: llmSnapshots.id, nodeId: llmSnapshots.nodeId, serverTime: llmSnapshots.serverTime, payload: llmSnapshots.payload })
          .from(llmSnapshots)
          .where(sql`${llmSnapshots.id} > ${state.lastId}`)
          .orderBy(llmSnapshots.id)
          .limit(BATCH);
        if (rows.length === 0) break;

        const deltas = new Map<string, LedgerDelta>();
        for (const row of rows) {
          state.lastId = row.id;
          const payload = row.payload as { ports?: unknown };
          if (!Array.isArray(payload?.ports)) continue;
          const bucketHour = floorIso(row.serverTime, "hour");
          const bucketDay = floorIso(row.serverTime, "day");
          for (const rawPort of payload.ports) {
            if (typeof rawPort !== "object" || rawPort === null) continue;
            const p = rawPort as {
              port?: unknown;
              model?: unknown;
              tokens?: { generated?: unknown; prompt?: unknown; cached?: unknown } | null;
            };
            if (typeof p.port !== "number") continue;
            const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
            const key = `${row.nodeId}:${p.port}`;
            const prev = state.counters[key] ?? { g: null, p: null, c: null };
            const next = {
              g: num(p.tokens?.generated),
              p: num(p.tokens?.prompt),
              c: num(p.tokens?.cached),
            };
            state.counters[key] = { g: next.g, p: next.p, c: next.c };
            if (next.g === null && next.p === null && next.c === null) continue; // backend publishes nothing

            const g = delta(prev.g, next.g);
            const pr = delta(prev.p, next.p);
            const c = delta(prev.c, next.c);
            if (!g.saw && !pr.saw && !c.saw) continue;
            const model = typeof p.model === "string" && p.model.length > 0 ? p.model : "unknown";

            for (const [granularity, bucketStart] of [
              ["hour", bucketHour],
              ["day", bucketDay],
            ] as const) {
              const mapKey = `${row.nodeId}:${p.port}:${model}:${granularity}:${bucketStart}`;
              const existing = deltas.get(mapKey);
              if (existing) {
                existing.dGen += g.d;
                existing.dPrompt += pr.d;
                existing.dCached += c.d;
                existing.sawGen = existing.sawGen || g.saw;
                existing.sawPrompt = existing.sawPrompt || pr.saw;
                existing.sawCached = existing.sawCached || c.saw;
              } else {
                deltas.set(mapKey, {
                  nodeId: row.nodeId,
                  port: p.port,
                  model,
                  granularity,
                  bucketStart,
                  dGen: g.d,
                  dPrompt: pr.d,
                  dCached: c.d,
                  sawGen: g.saw,
                  sawPrompt: pr.saw,
                  sawCached: c.saw,
                });
              }
            }
          }
        }

        for (const d of deltas.values()) {
          await db.execute(sql`
            insert into token_ledger
              (node_id, port, model, granularity, bucket_start, samples, generated_tokens, prompt_tokens, cached_tokens, generated_seen, prompt_seen, cached_seen)
            values (${d.nodeId}, ${d.port}, ${d.model}, ${sql.raw(`'${d.granularity}'::bucket_granularity`)}, ${d.bucketStart}, 1,
                    ${Math.round(d.dGen)}, ${Math.round(d.dPrompt)}, ${Math.round(d.dCached)}, ${d.sawGen}, ${d.sawPrompt}, ${d.sawCached})
            on conflict (node_id, port, model, granularity, bucket_start) do update set
              samples = token_ledger.samples + 1,
              generated_tokens = token_ledger.generated_tokens + ${Math.round(d.dGen)},
              prompt_tokens = token_ledger.prompt_tokens + ${Math.round(d.dPrompt)},
              cached_tokens = token_ledger.cached_tokens + ${Math.round(d.dCached)},
              generated_seen = token_ledger.generated_seen or ${d.sawGen},
              prompt_seen = token_ledger.prompt_seen or ${d.sawPrompt},
              cached_seen = token_ledger.cached_seen or ${d.sawCached}
          `);
          total += 1;
        }

        await db
          .insert(settings)
          .values({ key: TOKEN_LEDGER_STATE_KEY, value: state })
          .onConflictDoUpdate({ target: settings.key, set: { value: state } });

        if (rows.length < BATCH) break;
      }
      void total;
    },
  };
}

/** Prunes ledger rows past the bucket retention (mirror of the bucket knobs). */
export async function pruneTokenLedger(db: Db, hourKeepDays: number, dayKeepDays: number): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    with deleted as (
      delete from token_ledger
      where (granularity = 'hour' and bucket_start < now() - (${hourKeepDays} * interval '1 day'))
         or (granularity = 'day' and bucket_start < now() - (${dayKeepDays} * interval '1 day'))
      returning 1
    )
    select count(*)::int as n from deleted
  `);
  const rows = result as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
