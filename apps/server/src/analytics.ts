import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@irori/db";
import { llmBuckets, nodes, setups, snapshotBuckets, tokenLedger } from "@irori/db";
import {
  analyticsGranularity,
  analyticsRangeMs,
  analyticsResponseSchema,
  DEFAULT_BASE_OVERHEAD_W,
  GB10_SYSTEM_ENVELOPE_W,
  tokenCostMinor,
  type AnalyticsGroupBy,
  type AnalyticsLens,
  type AnalyticsRangeValue,
  type Currency,
  type AnalyticsPointInput,
  type AnalyticsResponse,
  type AnalyticsSeriesInput,
  type TokenTotals,
} from "@irori/core";

/**
 * Analytics (M7, SPEC §9): five lenses over the rollup buckets — never raw
 * scans. Bucket rows are read per node and folded into node or cluster
 * series with per-lens semantics (additive for decode/tokens/power/memory,
 * fleet-max for temps; see core/src/analytics.ts).
 */
export interface AnalyticsQuery {
  lens: AnalyticsLens;
  range: AnalyticsRangeValue;
  groupBy: AnalyticsGroupBy;
  /** Filter to one setup (cluster view) or one node. */
  setupId?: string;
  nodeId?: string;
}

export interface AnalyticsService {
  build(query: AnalyticsQuery): Promise<AnalyticsResponse>;
}

interface Membership {
  /** Setup key → display label. */
  labels: Map<string, string>;
  /** Setup key → member node ids. */
  members: Map<string, string[]>;
  /** nodeId → node name. */
  nodeNames: Map<string, string>;
  /** Nodes in no setup. */
  standalone: string[];
}

type Bucket = { t: number; v: AnalyticsPointInput };

export function createAnalyticsService(
  db: Db,
  opts: { pricing?: () => Promise<{ currency: Currency | null; resolve(model: string): { input: number; cached: number; output: number; currency: Currency } | null } | null> } = {},
): AnalyticsService {
  async function membership(): Promise<Membership> {
    const nodeRows = await db.select({ id: nodes.id, name: nodes.name }).from(nodes);
    const nodeNames = new Map(nodeRows.map((n) => [n.id, n.name]));
    const inSetup = new Set<string>();
    const labels = new Map<string, string>();
    const members = new Map<string, string[]>();
    const setupRows = await db.select({ id: setups.id, name: setups.name, headNodeId: setups.headNodeId, nodes: setups.nodes }).from(setups);
    for (const row of setupRows) {
      const ids = [row.headNodeId];
      const workers = toWorkerIds(row.nodes);
      ids.push(...workers);
      labels.set(row.id, row.name);
      members.set(row.id, ids);
      for (const id of ids) inSetup.add(id);
    }
    const standalone = nodeRows.map((n) => n.id).filter((id) => !inSetup.has(id));
    return { labels, members, nodeNames, standalone };
  }

  return {
    async build(query) {
      const granularity = analyticsGranularity(query.lens, query.range);
      const since = new Date(Date.now() - analyticsRangeMs(query.range));

      const member = await membership();
      const perNode = await lensBuckets(db, query, granularity, since);

      const series: AnalyticsSeriesInput[] = [];
      if (query.groupBy === "node") {
        for (const [nodeId, buckets] of perNode) {
          series.push({ key: nodeId, label: member.nodeNames.get(nodeId) ?? nodeId, points: [...buckets.values()].map((b) => b.v).sort((a, b) => a.t - b.t) });
        }
      } else {
        const groups: Array<{ key: string; label: string; ids: string[] }> = [];
        for (const [key, ids] of member.members) {
          if (query.setupId !== undefined && query.setupId !== key) continue;
          groups.push({ key, label: member.labels.get(key) ?? key, ids });
        }
        if (query.setupId === undefined && member.standalone.length > 0) {
          groups.push({ key: "standalone", label: "standalone", ids: member.standalone });
        }
        for (const group of groups) {
          series.push({ key: group.key, label: group.label, points: foldCluster(group.ids, perNode, query.lens) });
        }
      }
      series.sort((a, b) => a.label.localeCompare(b.label));

      const models = query.lens === "tokens" ? await tokenModels(db, since, granularity) : [];
      // IRI-040: fleet macro totals — the same scope as `series` (filters
      // applied), summed client-visibly from the folded buckets.
      let fleet: TokenTotals | null = null;
      let costMinor = 0;
      let costCurrency: Currency | null = null;
      if (query.lens === "tokens") {
        let gen = 0;
        let prompt = 0;
        let cached = 0;
        for (const s of series) {
          for (const p of s.points) {
            gen += p.generated ?? 0;
            prompt += p.prompt ?? 0;
            cached += p.cached ?? 0;
          }
        }
        const generated = Math.round(gen);
        const promptSum = Math.round(prompt);
        const cachedSum = Math.round(cached);
        fleet = {
          total: generated + promptSum,
          generated,
          prompt: promptSum,
          cached: cachedSum,
          cacheHitPct: promptSum > 0 ? Math.round((cachedSum / promptSum) * 1000) / 10 : 0,
        };
        // IRI-072: fleet cost priced per model (snapshot loaded once) so
        // overrides apply exactly as in the usage views.
        const pricing = opts.pricing === undefined ? null : await opts.pricing().catch(() => null);
        if (pricing !== null) {
          costCurrency = pricing.currency;
          for (const m of models) {
            costMinor += tokenCostMinor({ promptTokens: m.prompt, cachedTokens: m.cached, completionTokens: m.generated }, pricing.resolve(m.model)) ?? 0;
          }
        }
      }
      return analyticsResponseSchema.parse({ lens: query.lens, range: query.range, groupBy: query.groupBy, granularity, series, models, fleet, costMinor, costCurrency });
    },
  };
}

// ─── per-lens bucket readers ────────────────────────────────────────────────

async function lensBuckets(
  db: Db,
  query: AnalyticsQuery,
  granularity: "minute" | "hour" | "day",
  since: Date,
): Promise<Map<string, Map<number, Bucket>>> {
  const out = new Map<string, Map<number, Bucket>>();
  const push = (nodeId: string, point: AnalyticsPointInput) => {
    if (query.nodeId !== undefined && nodeId !== query.nodeId) return;
    let m = out.get(nodeId);
    if (m === undefined) {
      m = new Map();
      out.set(nodeId, m);
    }
    m.set(point.t, { t: point.t, v: point });
  };
  if (query.lens === "memory") {
    const rows = await db
      .select({ nodeId: snapshotBuckets.nodeId, bucketStart: snapshotBuckets.bucketStart, used: snapshotBuckets.memUsedBytes, total: snapshotBuckets.memTotalBytes, gpu: snapshotBuckets.gpuMemUsedBytes })
      .from(snapshotBuckets)
      .where(and(eq(snapshotBuckets.granularity, granularity), gte(snapshotBuckets.bucketStart, since)));
    for (const r of rows) {
      push(r.nodeId, { t: r.bucketStart.getTime(), usedBytes: r.used, totalBytes: r.total, gpuUsedBytes: r.gpu });
    }
    return out;
  }

  if (query.lens === "decode") {
    const rows = await db
      .select({ nodeId: llmBuckets.nodeId, bucketStart: llmBuckets.bucketStart, decode: llmBuckets.decodeTps, prefill: llmBuckets.prefillTps })
      .from(llmBuckets)
      .where(and(eq(llmBuckets.granularity, granularity), gte(llmBuckets.bucketStart, since)));
    for (const r of rows) {
      const t = r.bucketStart.getTime();
      const m = out.get(r.nodeId) ?? new Map<number, Bucket>();
      out.set(r.nodeId, m);
      const existing = m.get(t);
      // Multiple engine ports fold into one node bucket: tok/s adds; nulls
      // (engine publishes nothing) never zero out the sum — a bucket where
      // NO port published a metric stays null.
      if (existing) {
        const decodeSeen = (existing.v.decodeTps !== null && existing.v.decodeTps !== undefined) || r.decode !== null;
        existing.v.decodeTps = decodeSeen ? (existing.v.decodeTps ?? 0) + (r.decode ?? 0) : null;
        const prefillSeen = (existing.v.prefillTps !== null && existing.v.prefillTps !== undefined) || r.prefill !== null;
        existing.v.prefillTps = prefillSeen ? (existing.v.prefillTps ?? 0) + (r.prefill ?? 0) : null;
      } else {
        m.set(t, { t, v: { t, decodeTps: r.decode, prefillTps: r.prefill } });
      }
    }
    return out;
  }

  if (query.lens === "power") {
    const rows = await db
      .select({ nodeId: snapshotBuckets.nodeId, bucketStart: snapshotBuckets.bucketStart, gpu: snapshotBuckets.gpuPowerW, cpu: snapshotBuckets.packagePowerW })
      .from(snapshotBuckets)
      .where(and(eq(snapshotBuckets.granularity, granularity), gte(snapshotBuckets.bucketStart, since)));
    for (const r of rows) {
      const gpu = r.gpu ?? 0;
      const cpu = r.cpu ?? 0;
      push(r.nodeId, {
        t: r.bucketStart.getTime(),
        watts: Math.min(gpu + cpu + DEFAULT_BASE_OVERHEAD_W, GB10_SYSTEM_ENVELOPE_W),
        gpuW: r.gpu,
        cpuW: r.cpu,
        baseW: DEFAULT_BASE_OVERHEAD_W,
        coverage: r.gpu === null && r.cpu === null ? 0 : 1,
      });
    }
    return out;
  }

  if (query.lens === "temps") {
    const rows = await db
      .select({
        nodeId: snapshotBuckets.nodeId,
        bucketStart: snapshotBuckets.bucketStart,
        gpuMin: snapshotBuckets.gpuTempMinC,
        gpuMax: snapshotBuckets.gpuTempMaxC,
        gpuAvg: snapshotBuckets.gpuTempC,
        cpuMin: snapshotBuckets.cpuTempMinC,
        cpuMax: snapshotBuckets.cpuTempMaxC,
        cpuAvg: snapshotBuckets.cpuTempC,
        throttled: snapshotBuckets.gpuThrottled,
      })
      .from(snapshotBuckets)
      .where(and(eq(snapshotBuckets.granularity, granularity), gte(snapshotBuckets.bucketStart, since)));
    for (const r of rows) {
      push(r.nodeId, {
        t: r.bucketStart.getTime(),
        gpuMin: r.gpuMin,
        gpuMax: r.gpuMax,
        gpuAvg: r.gpuAvg,
        cpuMin: r.cpuMin,
        cpuMax: r.cpuMax,
        cpuAvg: r.cpuAvg,
        throttled: r.throttled,
      });
    }
    return out;
  }

  // tokens — ledger rows, summed across models per node (IRI-040 fix: the
  // nodeId filter was silently ignored here — this reader bypassed push()).
  const rows = await db
    .select({ nodeId: tokenLedger.nodeId, bucketStart: tokenLedger.bucketStart, gen: tokenLedger.generatedTokens, prompt: tokenLedger.promptTokens, cached: tokenLedger.cachedTokens })
    .from(tokenLedger)
    .where(and(eq(tokenLedger.granularity, granularity), gte(tokenLedger.bucketStart, since)));
  for (const r of rows) {
    if (query.nodeId !== undefined && r.nodeId !== query.nodeId) continue;
    const t = r.bucketStart.getTime();
    const m = out.get(r.nodeId) ?? new Map<number, Bucket>();
    out.set(r.nodeId, m);
    const existing = m.get(t);
    if (existing) {
      existing.v.generated = (existing.v.generated ?? 0) + r.gen;
      existing.v.prompt = (existing.v.prompt ?? 0) + r.prompt;
      existing.v.cached = (existing.v.cached ?? 0) + r.cached;
    } else {
      m.set(t, { t, v: { t, generated: r.gen, prompt: r.prompt, cached: r.cached } });
    }
  }
  return out;
}

/** Folds member nodes' buckets into one cluster series with lens semantics. */
function foldCluster(ids: string[], perNode: Map<string, Map<number, Bucket>>, lens: AnalyticsLens): AnalyticsPointInput[] {
  const times = new Set<number>();
  for (const id of ids) {
    const m = perNode.get(id);
    if (m === undefined) continue;
    for (const t of m.keys()) times.add(t);
  }
  const points: AnalyticsPointInput[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const buckets = ids.map((id) => perNode.get(id)?.get(t)).filter((b): b is Bucket => b !== undefined);
    if (buckets.length === 0) continue;
    const point: AnalyticsPointInput = { t };
    if (lens === "temps") {
      const pick = (key: "gpuMin" | "gpuMax" | "cpuMin" | "cpuMax", agg: "min" | "max") => {
        const vals = buckets.map((b) => b.v[key]).filter((v): v is number => typeof v === "number");
        if (vals.length === 0) return null;
        return agg === "min" ? Math.min(...vals) : Math.max(...vals);
      };
      const avg = (key: "gpuAvg" | "cpuAvg") => {
        const vals = buckets.map((b) => b.v[key]).filter((v): v is number => typeof v === "number");
        return vals.length === 0 ? null : vals.reduce((s, v) => s + v, 0) / vals.length;
      };
      point.gpuMin = pick("gpuMin", "min");
      point.gpuMax = pick("gpuMax", "max");
      point.gpuAvg = avg("gpuAvg");
      point.cpuMin = pick("cpuMin", "min");
      point.cpuMax = pick("cpuMax", "max");
      point.cpuAvg = avg("cpuAvg");
      const throttled = buckets.map((b) => b.v.throttled).filter((v): v is boolean => typeof v === "boolean");
      point.throttled = throttled.length === 0 ? null : throttled.some(Boolean);
    } else {
      // Additive lenses: sums across members; coverage = weakest member.
      const sum = (key: "usedBytes" | "totalBytes" | "gpuUsedBytes" | "decodeTps" | "prefillTps" | "watts" | "gpuW" | "cpuW" | "baseW" | "generated" | "prompt" | "cached") => {
        const vals = buckets.map((b) => b.v[key]).filter((v): v is number => typeof v === "number");
        return vals.length === 0 ? null : vals.reduce((s, v) => s + v, 0);
      };
      point.usedBytes = sum("usedBytes");
      point.totalBytes = sum("totalBytes");
      point.gpuUsedBytes = sum("gpuUsedBytes");
      point.decodeTps = sum("decodeTps");
      point.prefillTps = sum("prefillTps");
      point.watts = sum("watts");
      point.gpuW = sum("gpuW");
      point.cpuW = sum("cpuW");
      point.baseW = sum("baseW");
      point.generated = sum("generated");
      point.prompt = sum("prompt");
      point.cached = sum("cached");
      const coverages = buckets.map((b) => b.v.coverage).filter((v): v is number => typeof v === "number");
      point.coverage = coverages.length === 0 ? null : Math.min(...coverages);
    }
    points.push(point);
  }
  return points;
}

/** Tokens lens models (IRI-040): whole-ledger sums per model over the range —
 *  never a top-N subset (capped at 100 rows, homelab scale) — with the macro
 *  columns (total = generated + prompt; cacheHitPct = cached / prompt). */
async function tokenModels(db: Db, since: Date, granularity: "minute" | "hour" | "day") {
  const rows = await db
    .select({ model: tokenLedger.model, gen: sql<number>`sum(${tokenLedger.generatedTokens})::float8`, prompt: sql<number>`sum(${tokenLedger.promptTokens})::float8`, cached: sql<number>`sum(${tokenLedger.cachedTokens})::float8` })
    .from(tokenLedger)
    .where(and(eq(tokenLedger.granularity, granularity), gte(tokenLedger.bucketStart, since)))
    .groupBy(tokenLedger.model);
  return rows
    .map((r) => {
      const generated = Math.round(r.gen ?? 0);
      const prompt = Math.round(r.prompt ?? 0);
      const cached = Math.round(r.cached ?? 0);
      return { model: r.model, generated, prompt, cached, total: generated + prompt, cacheHitPct: prompt > 0 ? Math.round((cached / prompt) * 1000) / 10 : 0 };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 100);
}

function toWorkerIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => (typeof item === "object" && item !== null && typeof (item as { nodeId?: unknown }).nodeId === "string" ? [(item as { nodeId: string }).nodeId] : []));
}
