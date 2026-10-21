import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { llmParts, llmRequestParts, llmRequestTools, llmRequests, usageBuckets } from "@irori/db";
import type { Db } from "@irori/db";
import {
  usageRequestSchema,
  usageGranularity,
  usageRangeMs,
  type UsageAgentsResponse,
  type UsageErrorsResponse,
  type UsageFilters,
  type UsageModelsResponse,
  type UsageOverviewResponse,
  type UsageRange,
  type UsageRequest,
  type UsageRequestRow,
  type UsageRequestsResponse,
  type UsageToolsResponse,
} from "@irori/core";
import type { Granularity } from "./rollups.js";
import { resolveIdentities } from "./usage-identity.js";

/* ── IR-54: tool attribution ─────────────────────────────────────────────── */

/**
 * callId → tool name ring from observed responses (bounded). A server
 * restart forgets it: unresolved results attribute to "unknown" (documented
 * ADR-0010 §7) — attribution never blocks or errors.
 */
const TOOL_NAME_RING_CAP = 50_000;
const toolNameRing = new Map<string, string>();

function rememberToolCall(id: string, name: string): void {
  if (toolNameRing.size >= TOOL_NAME_RING_CAP) {
    for (const key of toolNameRing.keys()) {
      toolNameRing.delete(key);
      if (toolNameRing.size < TOOL_NAME_RING_CAP - 10_000) break;
    }
  }
  toolNameRing.set(id, name);
}

/**
 * Largest-remainder split of `total` across `weights` — the shares sum to
 * the total exactly (IR-54 acceptance). Zero weights → equal split.
 */
export function splitTokens(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map(() => 0);
  if (sum <= 0) {
    const base = Math.floor(total / n);
    const out = weights.map(() => base);
    let rest = total - base * n;
    for (let i = 0; rest > 0; i = (i + 1) % n, rest -= 1) out[i]! += 1;
    return out;
  }
  const exact = weights.map((w) => (w * total) / sum);
  const out = exact.map((v) => Math.floor(v));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (rest <= 0) break;
    out[i]! += 1;
    rest -= 1;
  }
  return out;
}

interface ToolAttr {
  tool: string;
  model: string | null;
  calls: number;
  errors: number;
  argsChars: number;
  resultChars: number;
  promptTokens: number;
  completionTokens: number;
}

/** Merges one event's response-calls and request-results into (tool) rows. */
function attributeTools(e: UsageRequest): ToolAttr[] {
  const rows = new Map<string, ToolAttr>();
  const row = (tool: string): ToolAttr => {
    let r = rows.get(tool);
    if (r === undefined) {
      r = { tool, model: e.model, calls: 0, errors: 0, argsChars: 0, resultChars: 0, promptTokens: 0, completionTokens: 0 };
      rows.set(tool, r);
    }
    return r;
  };

  // Request side first: results refer to calls made in EARLIER responses.
  const byCall = new Map<string, { resultChars: number; errors: number }>();
  for (const result of e.toolResults) {
    const name = toolNameRing.get(result.callId) ?? "unknown";
    const agg = byCall.get(name) ?? { resultChars: 0, errors: 0 };
    agg.resultChars += result.resultChars;
    if (result.error) agg.errors += 1;
    byCall.set(name, agg);
  }
  const promptShares = splitTokens(e.promptTokens ?? 0, [...byCall.values()].map((v) => v.resultChars));
  for (const [name, agg] of byCall) {
    const r = row(name);
    r.resultChars += agg.resultChars;
    r.errors += agg.errors;
  }
  for (const [i, name] of [...byCall.keys()].entries()) {
    row(name).promptTokens += promptShares[i] ?? 0;
  }

  // Response side: per-call entries grouped by name; completion tokens split
  // by assembled args length; ids remembered for the NEXT request's results.
  const byName = new Map<string, { calls: number; argsChars: number }>();
  for (const call of e.respTools) {
    const agg = byName.get(call.name) ?? { calls: 0, argsChars: 0 };
    agg.calls += 1;
    agg.argsChars += call.argsChars;
    byName.set(call.name, agg);
    if (call.id !== null) rememberToolCall(call.id, call.name);
  }
  const completionShares = splitTokens(e.completionTokens ?? 0, [...byName.values()].map((v) => v.argsChars));
  for (const [i, name] of [...byName.keys()].entries()) {
    const agg = byName.get(name)!;
    const r = row(name);
    r.calls += agg.calls;
    r.argsChars += agg.argsChars;
    r.completionTokens += completionShares[i] ?? 0;
  }
  return [...rows.values()];
}

/**
 * Usage persistence + read models (M8, ADR-0008 §4/§6). Durable inserts are
 * deduplicated by the client UUID primary key; reads aggregate precomputed
 * `usage_buckets` (raw only for the requests list). Nulls mean "not
 * detected", never zero — mirrors the probe contracts.
 */

export interface UsageStore {
  /** Inserts a batch; returns the number of NEW rows (duplicates skipped). */
  insertBatch(nodeId: string, events: UsageRequest[]): Promise<number>;
  overview(filters: UsageFilters): Promise<UsageOverviewResponse>;
  requests(
    filters: UsageFilters & { page: number; limit: number; errorOnly?: boolean; sig?: string; status?: number },
  ): Promise<UsageRequestsResponse>;
  requestById(id: string): Promise<UsageRequestRow | null>;
  errorGroups(filters: UsageFilters): Promise<UsageErrorsResponse>;
  models(filters: UsageFilters): Promise<UsageModelsResponse>;
  /** Client-identity groups over raw rows (IR-55 Agents view). */
  agents(filters: UsageFilters): Promise<UsageAgentsResponse>;
  /** Tool attribution table + top-tool token series (IR-54 Tools view). */
  tools(filters: UsageFilters): Promise<UsageToolsResponse>;
  /** Deletes raw requests older than `olderThan`; returns the deleted count. */
  pruneRaw(olderThan: Date): Promise<number>;
  /** Deletes usage buckets of one granularity older than `keepDays`. */
  pruneBuckets(granularity: Granularity, keepDays: number): Promise<number>;
}

/** Window start for a range, bucket-aligned at the read granularity. */
function rangeWindow(range: UsageRange): { granularity: "hour" | "day"; sinceIso: string } {
  const granularity = usageGranularity(range);
  const ms = usageRangeMs(range);
  const alignedMs = granularity === "day" ? 86_400_000 : 3_600_000;
  const since = Math.floor((Date.now() - ms) / alignedMs) * alignedMs;
  return { granularity, sinceIso: new Date(since).toISOString() };
}

/**
 * Start of the current (still-open) bucket at the read granularity. Buckets
 * are only computed once complete, so overview/models fold the open bucket's
 * raw rows in on read — otherwise live traffic is invisible for up to an
 * hour (ADR-0008 keying is server ingest time either way).
 */
function openBucketStart(granularity: "hour" | "day"): string {
  const alignedMs = granularity === "day" ? 86_400_000 : 3_600_000;
  return new Date(Math.floor(Date.now() / alignedMs) * alignedMs).toISOString();
}

/** Additive/weighted aggregate over request groups (open-bucket merge). */
interface Agg {
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  decodeTps: number | null;
}

/** Raw open-bucket rows projected for aggregation. */
function openBucketCte(openStartIso: string, nodeId?: string, model?: string): SQL {
  return sql`
    with open_rows as (
      select model, (error is not null or status >= 400) as failed,
             prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
             total_tokens, ttft_ms, decode_tps
      from llm_requests
      where received_at >= ${openStartIso}::timestamptz
      ${nodeId === undefined ? sql`` : sql`and node_id = ${nodeId}`}
      ${model === undefined ? sql`` : sql`and model = ${model}`}
    )
  `;
}

function toAgg(r: Record<string, unknown>): Agg {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const nullable = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    requests: num(r.requests),
    errors: num(r.errors),
    promptTokens: num(r.prompt_tokens),
    completionTokens: num(r.completion_tokens),
    cachedTokens: num(r.cached_tokens),
    reasoningTokens: num(r.reasoning_tokens),
    totalTokens: num(r.total_tokens),
    ttftP50Ms: nullable(r.ttft_p50),
    ttftP95Ms: nullable(r.ttft_p95),
    decodeTps: nullable(r.decode_tps),
  };
}

function sumAggs(aggs: Agg[]): Agg {
  return aggs.reduce((a, b) => mergeAgg(a, b));
}

/** Additive counts/tokens; request-weighted percentiles; token-weighted tps. */
function mergeAgg(a: Agg, b: Agg): Agg {
  const weighted = (va: number | null, wa: number, vb: number | null, wb: number): number | null => {
    const total = wa + wb;
    if (total === 0) return null;
    const num = (v: number | null, w: number): number => ((v ?? 0) * w);
    return (num(va, wa) + num(vb, wb)) / total;
  };
  const wA = a.requests;
  const wB = b.requests;
  const dW = a.completionTokens + b.completionTokens;
  return {
    requests: a.requests + b.requests,
    errors: a.errors + b.errors,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: dW,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ttftP50Ms: weighted(a.ttftP50Ms, wA, b.ttftP50Ms, wB),
    ttftP95Ms: weighted(a.ttftP95Ms, wA, b.ttftP95Ms, wB),
    decodeTps: dW > 0 ? ((a.decodeTps ?? 0) * a.completionTokens + (b.decodeTps ?? 0) * b.completionTokens) / dW : null,
  };
}

type UsageSeriesPoint = UsageOverviewResponse["series"][number];

function aggOfPoint(p: UsageSeriesPoint): Agg {
  return {
    requests: p.requests,
    errors: p.errors,
    promptTokens: p.promptTokens,
    completionTokens: p.completionTokens,
    cachedTokens: p.cachedTokens,
    reasoningTokens: p.reasoningTokens,
    totalTokens: p.totalTokens,
    ttftP50Ms: p.ttftP50Ms,
    ttftP95Ms: p.ttftP95Ms,
    decodeTps: p.decodeTps,
  };
}

function aggIntoPoint(a: Agg, t: string): UsageSeriesPoint {
  return {
    t,
    requests: a.requests,
    errors: a.errors,
    promptTokens: a.promptTokens,
    completionTokens: a.completionTokens,
    cachedTokens: a.cachedTokens,
    reasoningTokens: a.reasoningTokens,
    totalTokens: a.totalTokens,
    ttftP50Ms: a.ttftP50Ms,
    ttftP95Ms: a.ttftP95Ms,
    decodeTps: a.decodeTps,
  };
}

export function createUsageStore(db: Db): UsageStore {
  return {
    async insertBatch(nodeId, events) {
      if (events.length === 0) return 0;
      const rows = [];
      const parsedEvents: UsageRequest[] = [];
      for (const event of events) {
        const parsed = usageRequestSchema.safeParse(event);
        if (!parsed.success) continue; // malformed frames never block the rest
        parsedEvents.push(parsed.data);
      }
      if (parsedEvents.length === 0) return 0;
      // IR-55: resolve issued-key identities once per batch; header-declared
      // fields fill what the key match does not set (ADR-0010 §8).
      const identities = await resolveIdentities(db, [...new Set(parsedEvents.map((e) => e.clientKeyHash).filter((h): h is string => h !== null))]);
      for (const e of parsedEvents) {
        const mapped = e.clientKeyHash !== null ? identities.get(e.clientKeyHash) ?? null : null;
        rows.push({
          id: e.id,
          nodeId,
          setupId: e.setupId,
          port: e.port,
          ts: new Date(e.ts),
          model: e.model,
          endpoint: e.endpoint,
          stream: e.stream,
          status: e.status,
          finishReason: e.finishReason,
          error: e.error,
          errorSig: e.errorSig,
          durationMs: e.durationMs,
          ttftMs: e.ttftMs,
          decodeTps: e.decodeTps,
          promptTokens: e.promptTokens,
          completionTokens: e.completionTokens,
          cachedTokens: e.cachedTokens,
          reasoningTokens: e.reasoningTokens,
          totalTokens: e.totalTokens,
          engineMeta: e.engineMeta,
          reqBytes: e.reqBytes,
          resBytes: e.resBytes,
          sourceAddr: e.sourceAddr,
          clientKeyHash: e.clientKeyHash,
          clientName: mapped?.name ?? e.clientName ?? null,
          clientProject: mapped?.project ?? e.clientProject ?? null,
          clientAgentType: mapped?.agentType ?? e.clientAgentType ?? null,
          retryAttempt: e.retryAttempt,
          retryKind: e.retryKind,
          retryStatus: e.retryStatus,
          retrySupersededBy: e.retrySupersededBy,
        });
      }
      const inserted = await db
        .insert(llmRequests)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: llmRequests.id });
      const insertedIds = new Set(inserted.map((r) => r.id));
      // IR-52: content-addressed parts — only for rows that are NEW, so a
      // redelivered batch never double-counts refcounts (exactly-once holds).
      const joinRows: Array<{
        requestId: string;
        ordinal: number;
        hash: string;
        kind: string;
        role: string | null;
        bytes: number;
        truncated: boolean;
      }> = [];
      const partRefs = new Map<string, { refcount: number; bytes: number; gz: Buffer; truncated: boolean }>();
      for (const event of parsedEvents) {
        if (!insertedIds.has(event.id) || event.parts.length === 0) continue;
        for (const [ordinal, part] of event.parts.entries()) {
          joinRows.push({
            requestId: event.id,
            ordinal,
            hash: part.hash,
            kind: part.kind,
            role: part.role,
            bytes: part.bytes,
            truncated: part.truncated,
          });
          const known = partRefs.get(part.hash);
          if (known !== undefined) {
            known.refcount += 1;
          } else {
            partRefs.set(part.hash, {
              refcount: 1,
              bytes: part.bytes,
              gz: Buffer.from(part.gz, "base64"),
              truncated: part.truncated,
            });
          }
        }
      }
      if (partRefs.size > 0) {
        await db.transaction(async (tx) => {
          await tx
            .insert(llmParts)
            .values([...partRefs.entries()].map(([hash, ref]) => ({ hash, ...ref })))
            .onConflictDoUpdate({
              target: llmParts.hash,
              set: { refcount: sql`${llmParts.refcount} + excluded.refcount` },
            });
          if (joinRows.length > 0) await tx.insert(llmRequestParts).values(joinRows).onConflictDoNothing();
        });
      }
      // IR-54: attribute tool usage for NEW rows only (replays are no-ops).
      const toolRows = parsedEvents
        .filter((e) => insertedIds.has(e.id) && (e.respTools.length > 0 || e.toolResults.length > 0))
        .flatMap((e) => attributeTools(e).map((row) => ({ ...row, requestId: e.id })));
      if (toolRows.length > 0) {
        await db.insert(llmRequestTools).values(toolRows).onConflictDoNothing();
      }
      return inserted.length;
    },

    async overview({ range, nodeId, model }) {
      const { granularity, sinceIso } = rangeWindow(range);
      const conds = [sql`b.granularity = ${granularity}::bucket_granularity`, sql`b.bucket_start >= ${sinceIso}::timestamptz`];
      if (nodeId !== undefined) conds.push(sql`b.node_id = ${nodeId}`);
      if (model !== undefined) conds.push(sql`b.model = ${model}`);
      const where = sql.join(conds, sql` and `);

      const seriesRows = await db.execute(sql`
        select b.bucket_start as t, sum(b.requests)::int as requests, sum(b.errors)::int as errors,
               sum(b.prompt_tokens)::float8 as prompt_tokens, sum(b.completion_tokens)::float8 as completion_tokens,
               sum(b.cached_tokens)::float8 as cached_tokens, sum(b.reasoning_tokens)::float8 as reasoning_tokens,
               sum(b.total_tokens)::float8 as total_tokens,
               (sum(b.ttft_p50_ms * b.requests) / nullif(sum(b.requests), 0))::float8 as ttft_p50_ms,
               (sum(b.ttft_p95_ms * b.requests) / nullif(sum(b.requests), 0))::float8 as ttft_p95_ms,
               (sum(b.decode_tps * b.decode_tps_weight) / nullif(sum(b.decode_tps_weight), 0))::float8 as decode_tps
        from usage_buckets b
        where ${where}
        group by b.bucket_start
        order by b.bucket_start
      `);
      const mixRows = await db.execute(sql`
        select b.model, sum(b.requests)::int as requests, sum(b.errors)::int as errors,
               sum(b.prompt_tokens)::float8 as prompt_tokens, sum(b.completion_tokens)::float8 as completion_tokens,
               sum(b.cached_tokens)::float8 as cached_tokens, sum(b.reasoning_tokens)::float8 as reasoning_tokens,
               sum(b.total_tokens)::float8 as total_tokens
        from usage_buckets b
        where ${where}
        group by b.model
        order by sum(b.total_tokens) desc
      `);

      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const nullable = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const series = seriesRows.map((r) => ({
        t: new Date(r.t as string).toISOString(),
        requests: num(r.requests),
        errors: num(r.errors),
        promptTokens: num(r.prompt_tokens),
        completionTokens: num(r.completion_tokens),
        cachedTokens: num(r.cached_tokens),
        reasoningTokens: num(r.reasoning_tokens),
        totalTokens: num(r.total_tokens),
        ttftP50Ms: nullable(r.ttft_p50_ms),
        ttftP95Ms: nullable(r.ttft_p95_ms),
        decodeTps: nullable(r.decode_tps),
      }));
      const tokenMix: Array<{ model: string; requests: number; errors: number; promptTokens: number; completionTokens: number; cachedTokens: number; reasoningTokens: number; totalTokens: number }> = mixRows.map((r) => ({
        model: String(r.model),
        requests: num(r.requests),
        errors: num(r.errors),
        promptTokens: num(r.prompt_tokens),
        completionTokens: num(r.completion_tokens),
        cachedTokens: num(r.cached_tokens),
        reasoningTokens: num(r.reasoning_tokens),
        totalTokens: num(r.total_tokens),
      }));

      // Fold the still-open bucket's raw rows in on read — buckets are only
      // computed once complete, and live traffic must show up now (ADR-0008).
      const openStart = openBucketStart(granularity);
      const openRows = await db.execute(sql`
        ${openBucketCte(openStart, nodeId, model)}
        select model, count(*)::int as requests, count(*) filter (where failed)::int as errors,
               coalesce(sum(prompt_tokens), 0)::float8 as prompt_tokens,
               coalesce(sum(completion_tokens), 0)::float8 as completion_tokens,
               coalesce(sum(cached_tokens), 0)::float8 as cached_tokens,
               coalesce(sum(reasoning_tokens), 0)::float8 as reasoning_tokens,
               coalesce(sum(total_tokens), 0)::float8 as total_tokens,
               percentile_cont(0.5) within group (order by ttft_ms)::float8 as ttft_p50,
               percentile_cont(0.95) within group (order by ttft_ms)::float8 as ttft_p95,
               (sum(completion_tokens * decode_tps) / nullif(sum(completion_tokens), 0))::float8 as decode_tps
        from open_rows
        group by model
      `);
      if (openRows.length > 0) {
        const openByModel = new Map<string, Agg>();
        for (const r of openRows) openByModel.set(String(r.model), toAgg(r));
        // Series tail: merge into the open bucket point (or append it).
        const openAgg = sumAggs([...openByModel.values()]);
        const existing = series.find((p) => p.t === openStart);
        if (existing !== undefined) Object.assign(existing, aggIntoPoint(mergeAgg(aggOfPoint(existing), openAgg), openStart));
        else {
          series.push(aggIntoPoint(openAgg, openStart));
          series.sort((a, b) => a.t.localeCompare(b.t));
        }
        // Token mix: per-model additive merge.
        for (const [m, agg] of openByModel) {
          const row = tokenMix.find((x) => x.model === m);
          if (row !== undefined) {
            row.requests += agg.requests;
            row.errors += agg.errors;
            row.promptTokens += agg.promptTokens;
            row.completionTokens += agg.completionTokens;
            row.cachedTokens += agg.cachedTokens;
            row.reasoningTokens += agg.reasoningTokens;
            row.totalTokens += agg.totalTokens;
          } else {
            tokenMix.push({ model: m, ...agg });
          }
        }
        tokenMix.sort((a, b) => b.totalTokens - a.totalTokens);
      }

      // KPIs fold the whole (merged) series: request-weighted percentiles,
      // token-weighted decode tps.
      const kpis = series.reduce(
        (acc, p) => ({
          requests: acc.requests + p.requests,
          errors: acc.errors + p.errors,
          promptTokens: acc.promptTokens + p.promptTokens,
          completionTokens: acc.completionTokens + p.completionTokens,
          cachedTokens: acc.cachedTokens + p.cachedTokens,
          reasoningTokens: acc.reasoningTokens + p.reasoningTokens,
          totalTokens: acc.totalTokens + p.totalTokens,
          ttftP50Ms: null as number | null,
          ttftP95Ms: null as number | null,
          decodeTps: null as number | null,
        }),
        {
          requests: 0,
          errors: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          ttftP50Ms: null as number | null,
          ttftP95Ms: null as number | null,
          decodeTps: null as number | null,
        },
      );
      const totalWeight = series.reduce((s, p) => s + p.requests, 0);
      kpis.ttftP50Ms = totalWeight > 0 ? (series.reduce((s, p) => s + (p.ttftP50Ms ?? 0) * p.requests, 0) / totalWeight) || null : null;
      kpis.ttftP95Ms = totalWeight > 0 ? (series.reduce((s, p) => s + (p.ttftP95Ms ?? 0) * p.requests, 0) / totalWeight) || null : null;
      const weight = series.reduce((s, p) => s + p.completionTokens, 0);
      kpis.decodeTps = weight > 0 ? (series.reduce((s, p) => s + (p.decodeTps ?? 0) * p.completionTokens, 0) / weight) || null : null;

      return { range, granularity, kpis, series, tokenMix };
    },

    async requests({ range, nodeId, model, project, agentType, page, limit, errorOnly, sig, status }) {
      const sinceIso = new Date(Date.now() - usageRangeMs(range)).toISOString();
      const conds = [sql`r.received_at >= ${sinceIso}::timestamptz`];
      if (nodeId !== undefined) conds.push(sql`r.node_id = ${nodeId}`);
      if (model !== undefined) conds.push(sql`r.model = ${model}`);
      if (errorOnly === true) conds.push(sql`(r.error is not null or r.status >= 400)`);
      if (sig !== undefined) conds.push(sql`r.error_sig = ${sig}`);
      if (status !== undefined) conds.push(sql`r.status = ${status}`);
      if (project !== undefined) conds.push(sql`r.client_project = ${project}`);
      if (agentType !== undefined) conds.push(sql`r.client_agent_type = ${agentType}`);
      const where = sql.join(conds, sql` and `);

      const totalRows = await db.execute(sql`select count(*)::int as total from llm_requests r where ${where}`);
      const total = totalRows[0] !== undefined ? Number(totalRows[0].total) : 0;
      const rows = await db.execute(sql`
        select
          r.id, r.node_id as "nodeId", r.setup_id as "setupId", r.port,
          r.ts, r.model, r.endpoint, r.stream, r.status,
          r.finish_reason as "finishReason", r.error, r.error_sig as "errorSig",
          r.duration_ms as "durationMs", r.ttft_ms as "ttftMs", r.decode_tps as "decodeTps",
          r.prompt_tokens as "promptTokens", r.completion_tokens as "completionTokens",
          r.cached_tokens as "cachedTokens", r.reasoning_tokens as "reasoningTokens",
          r.total_tokens as "totalTokens", r.engine_meta as "engineMeta",
          r.req_bytes as "reqBytes", r.res_bytes as "resBytes",
          r.source_addr as "sourceAddr",
          r.client_key_hash as "clientKeyHash", r.client_name as "clientName",
          r.client_project as "clientProject", r.client_agent_type as "clientAgentType",
          r.retry_attempt as "retryAttempt", r.retry_kind as "retryKind",
          r.retry_status as "retryStatus", r.retry_superseded_by as "retrySupersededBy",
          r.received_at as "receivedAt"
        from llm_requests r
        where ${where}
        order by r.received_at desc
        limit ${limit} offset ${Math.max(0, (page - 1) * limit)}
      `);
      return { total, rows: rows.map(rowToRequest) };
    },

    async requestById(id) {
      const rows = await db.select().from(llmRequests).where(eq(llmRequests.id, id)).limit(1);
      return rows[0] !== undefined ? rowToRequest(rows[0] as unknown as Record<string, unknown>) : null;
    },

    async errorGroups({ range, nodeId, model }) {
      const sinceIso = new Date(Date.now() - usageRangeMs(range)).toISOString();
      const conds = [sql`r.received_at >= ${sinceIso}::timestamptz`, sql`r.error_sig is not null`];
      if (nodeId !== undefined) conds.push(sql`r.node_id = ${nodeId}`);
      if (model !== undefined) conds.push(sql`r.model = ${model}`);
      const where = sql.join(conds, sql` and `);
      const rows = await db.execute(sql`
        select r.error_sig as sig, count(*)::int as count,
               min(r.received_at) as first_seen, max(r.received_at) as last_seen,
               max(r.error) as sample,
               array_remove(array_agg(distinct r.model), null) as models,
               max(r.status)::int as status
        from llm_requests r
        where ${where}
        group by r.error_sig
        order by count(*) desc, max(r.received_at) desc
        limit 100
      `);
      return {
        range,
        groups: rows.map((r) => ({
          sig: String(r.sig),
          count: Number(r.count),
          firstSeenMs: new Date(r.first_seen as string).getTime(),
          lastSeenMs: new Date(r.last_seen as string).getTime(),
          sample: String(r.sample ?? ""),
          models: (r.models as Array<string | null> | null)?.filter((m): m is string => m !== null) ?? [],
          status: typeof r.status === "number" ? r.status : null,
        })),
      };
    },

    async models({ range, nodeId }) {
      const { granularity, sinceIso } = rangeWindow(range);
      const conds = [sql`b.granularity = ${granularity}::bucket_granularity`, sql`b.bucket_start >= ${sinceIso}::timestamptz`];
      if (nodeId !== undefined) conds.push(sql`b.node_id = ${nodeId}`);
      const where = sql.join(conds, sql` and `);

      const modelRows = await db.execute(sql`
        select b.model, sum(b.requests)::int as requests, sum(b.errors)::int as errors,
               sum(b.total_tokens)::float8 as total_tokens,
               (sum(b.ttft_p50_ms * b.requests) / nullif(sum(b.requests), 0))::float8 as ttft_p50_ms,
               (sum(b.ttft_p95_ms * b.requests) / nullif(sum(b.requests), 0))::float8 as ttft_p95_ms,
               (sum(b.decode_tps * b.decode_tps_weight) / nullif(sum(b.decode_tps_weight), 0))::float8 as decode_tps
        from usage_buckets b
        where ${where}
        group by b.model
        order by sum(b.total_tokens) desc
        limit 50
      `);
      const seriesRows = await db.execute(sql`
        select b.model, b.bucket_start as t,
               (sum(b.ttft_p50_ms * b.requests) / nullif(sum(b.requests), 0))::float8 as ttft_p50_ms,
               (sum(b.decode_tps * b.decode_tps_weight) / nullif(sum(b.decode_tps_weight), 0))::float8 as decode_tps,
               sum(b.completion_tokens)::float8 as completion_tokens
        from usage_buckets b
        where ${where}
        group by b.model, b.bucket_start
        order by b.bucket_start
      `);

      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const nullable = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const byModel = new Map<string, Array<{ t: string; ttftP50Ms: number | null; decodeTps: number | null; completionTokens: number }>>();
      for (const r of seriesRows) {
        const model = String(r.model);
        const list = byModel.get(model) ?? [];
        list.push({
          t: new Date(r.t as string).toISOString(),
          ttftP50Ms: nullable(r.ttft_p50_ms),
          decodeTps: nullable(r.decode_tps),
          completionTokens: num(r.completion_tokens),
        });
        byModel.set(model, list);
      }

      // Open-bucket raw merge (same rationale as overview): per-model rows
      // and a series point for the still-open bucket.
      const openStart = openBucketStart(granularity);
      const openRows = await db.execute(sql`
        ${openBucketCte(openStart, nodeId, undefined)}
        select model, count(*)::int as requests, count(*) filter (where failed)::int as errors,
               coalesce(sum(total_tokens), 0)::float8 as total_tokens,
               percentile_cont(0.5) within group (order by ttft_ms)::float8 as ttft_p50,
               percentile_cont(0.95) within group (order by ttft_ms)::float8 as ttft_p95,
               (sum(completion_tokens * decode_tps) / nullif(sum(completion_tokens), 0))::float8 as decode_tps,
               sum(completion_tokens)::float8 as completion_tokens
        from open_rows
        group by model
      `);
      const modelAggs = new Map<string, Agg>();
      for (const r of openRows) modelAggs.set(String(r.model), toAgg(r));

      const modelList = modelRows.map((r) => ({
        model: String(r.model),
        requests: num(r.requests),
        errors: num(r.errors),
        totalTokens: num(r.total_tokens),
        ttftP50Ms: nullable(r.ttft_p50_ms),
        ttftP95Ms: nullable(r.ttft_p95_ms),
        decodeTps: nullable(r.decode_tps),
      }));
      for (const [m, agg] of modelAggs) {
        const row = modelList.find((x) => x.model === m);
        if (row !== undefined) {
          const merged = mergeAgg(
            {
              requests: row.requests,
              errors: row.errors,
              promptTokens: 0,
              completionTokens: 0,
              cachedTokens: 0,
              reasoningTokens: 0,
              totalTokens: row.totalTokens,
              ttftP50Ms: row.ttftP50Ms,
              ttftP95Ms: row.ttftP95Ms,
              decodeTps: row.decodeTps,
            },
            agg,
          );
          row.requests = merged.requests;
          row.errors = merged.errors;
          row.totalTokens = merged.totalTokens;
          row.ttftP50Ms = merged.ttftP50Ms;
          row.ttftP95Ms = merged.ttftP95Ms;
          row.decodeTps = merged.decodeTps;
        } else {
          modelList.push({ model: m, requests: agg.requests, errors: agg.errors, totalTokens: agg.totalTokens, ttftP50Ms: agg.ttftP50Ms, ttftP95Ms: agg.ttftP95Ms, decodeTps: agg.decodeTps });
        }
        const points = byModel.get(m) ?? [];
        const openPoint = points.find((p) => p.t === openStart);
        const pointAgg = { ...agg, completionTokens: Math.trunc(agg.completionTokens) };
        if (openPoint !== undefined) {
          const mergedPoint = mergeAgg(
            { requests: 0, errors: 0, promptTokens: 0, completionTokens: openPoint.completionTokens, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0, ttftP50Ms: openPoint.ttftP50Ms, ttftP95Ms: null, decodeTps: openPoint.decodeTps },
            pointAgg,
          );
          openPoint.ttftP50Ms = mergedPoint.ttftP50Ms;
          openPoint.decodeTps = mergedPoint.decodeTps;
          openPoint.completionTokens = mergedPoint.completionTokens;
        } else {
          points.push({ t: openStart, ttftP50Ms: pointAgg.ttftP50Ms, decodeTps: pointAgg.decodeTps, completionTokens: pointAgg.completionTokens });
          points.sort((a, b) => a.t.localeCompare(b.t));
        }
        byModel.set(m, points);
      }
      modelList.sort((a, b) => b.totalTokens - a.totalTokens);

      return {
        range,
        models: modelList,
        series: [...byModel.entries()].map(([model, points]) => ({ model, points })),
      };
    },

    async agents({ range, nodeId }) {
      const sinceIso = new Date(Date.now() - usageRangeMs(range)).toISOString();
      const conds = [sql`r.received_at >= ${sinceIso}::timestamptz`];
      if (nodeId !== undefined) conds.push(sql`r.node_id = ${nodeId}`);
      const where = sql.join(conds, sql` and `);
      // Identified rows group by their resolved identity; rows with none group
      // per source address (the fallback label, IR-55).
      const rows = await db.execute(sql`
        select
          r.client_project as project, r.client_agent_type as agent_type,
          r.client_name as name, r.client_key_hash as key_hash,
          case when r.client_key_hash is null and r.client_name is null
                    and r.client_project is null and r.client_agent_type is null
               then r.source_addr else null end as fallback_addr,
          count(*)::int as requests,
          count(*) filter (where r.error is not null or r.status >= 400)::int as errors,
          coalesce(sum(r.prompt_tokens), 0)::float8 as prompt_tokens,
          coalesce(sum(r.completion_tokens), 0)::float8 as completion_tokens,
          coalesce(sum(r.total_tokens), 0)::float8 as total_tokens,
          max(r.received_at) as last_seen,
          array_remove(array_agg(distinct r.source_addr), null) as source_addrs
        from llm_requests r
        where ${where}
        group by 1, 2, 3, 4, 5
        order by sum(coalesce(r.total_tokens, 0)) desc, max(r.received_at) desc
        limit 201
      `);
      const truncated = rows.length > 200;
      const visible = truncated ? rows.slice(0, 200) : rows;
      const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
      return {
        range,
        truncated,
        groups: visible.map((r) => {
          const fallback = str(r.fallback_addr);
          const addrs = ((r.source_addrs as Array<string | null> | null) ?? []).filter((a): a is string => typeof a === "string" && a.length > 0);
          return {
            project: str(r.project),
            agentType: r.agent_type === "main" || r.agent_type === "subagent" ? r.agent_type : null,
            name: str(r.name),
            keyHash: str(r.key_hash),
            sourceAddrs: fallback !== null && !addrs.includes(fallback) ? [...addrs, fallback] : addrs,
            requests: Number(r.requests),
            errors: Number(r.errors),
            promptTokens: Number(r.prompt_tokens ?? 0),
            completionTokens: Number(r.completion_tokens ?? 0),
            totalTokens: Number(r.total_tokens ?? 0),
            lastSeenMs: new Date(String(r.last_seen)).getTime(),
          };
        }),
      };
    },

    async tools({ range, nodeId, model }) {
      const sinceIso = new Date(Date.now() - usageRangeMs(range)).toISOString();
      const granularity = usageGranularity(range);
      const bucket = sql.raw(`'${granularity === "day" ? "day" : "hour"}'`);
      const conds = [sql`r.received_at >= ${sinceIso}::timestamptz`];
      if (nodeId !== undefined) conds.push(sql`r.node_id = ${nodeId}`);
      if (model !== undefined) conds.push(sql`r.model = ${model}`);
      const where = sql.join(conds, sql` and `);

      const rows = await db.execute(sql`
        select t.tool, t.model,
               sum(t.calls)::int as calls, sum(t.errors)::int as errors,
               sum(t.args_chars)::int as args_chars, sum(t.result_chars)::int as result_chars,
               sum(t.prompt_tokens)::int as prompt_tokens, sum(t.completion_tokens)::int as completion_tokens,
               max(r.received_at) as last_seen
        from llm_request_tools t
        join llm_requests r on r.id = t.request_id
        where ${where}
        group by t.tool, t.model
        order by sum(t.prompt_tokens + t.completion_tokens) desc, max(r.received_at) desc
        limit 100
      `);

      // Token series for the top 8 tools by attributed tokens.
      const topTools = (rows as unknown as Array<{ tool: string }>).slice(0, 8).map((r) => r.tool);
      let series: UsageToolsResponse["series"] = [];
      if (topTools.length > 0) {
        const toolList = sql.join(topTools.map((tool) => sql`${tool}`), sql`, `);
        const seriesRows = await db.execute(sql`
          select t.tool, date_trunc(${bucket}, r.received_at) as t,
                 sum(t.prompt_tokens + t.completion_tokens)::int as tokens
          from llm_request_tools t
          join llm_requests r on r.id = t.request_id
          where ${where} and t.tool in (${toolList})
          group by t.tool, 2
          order by 2
        `);
        const byTool = new Map<string, Array<{ t: string; tokens: number }>>();
        for (const r of seriesRows as unknown as Array<{ tool: string; t: string; tokens: number }>) {
          const list = byTool.get(r.tool) ?? [];
          list.push({ t: new Date(r.t).toISOString(), tokens: Number(r.tokens) });
          byTool.set(r.tool, list);
        }
        series = [...byTool.entries()].map(([tool, points]) => ({ tool, points }));
      }

      const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
      return {
        range,
        tools: (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
          tool: String(r.tool),
          model: typeof r.model === "string" && r.model.length > 0 ? r.model : null,
          calls: int(r.calls),
          errors: int(r.errors),
          argsChars: int(r.args_chars),
          resultChars: int(r.result_chars),
          promptTokens: int(r.prompt_tokens),
          completionTokens: int(r.completion_tokens),
          lastSeenMs: new Date(String(r.last_seen)).getTime(),
        })),
        series,
      };
    },

    async pruneRaw(olderThan) {
      // IR-52: parts die with their owning rows — delete requests, release
      // their part references, then drop parts whose refcount hit zero.
      const result = (await db.execute(sql`
        with doomed as (
          delete from llm_requests
          where received_at < ${olderThan.toISOString()}::timestamptz
          returning id
        ),
        refs as (
          delete from llm_request_parts
          where request_id in (select id from doomed)
          returning hash
        ),
        tally as (
          select hash, count(*)::int as refs from refs group by hash
        ),
        decremented as (
          update llm_parts p
          set refcount = p.refcount - t.refs
          from tally t
          where p.hash = t.hash
          returning p.hash
        )
        select
          (select count(*) from doomed)::int as requests
      `)) as unknown as Array<{ requests: number }>;
      const row = result[0];
      await db.execute(sql`delete from llm_parts where refcount <= 0`);
      return row !== undefined ? Number(row.requests) : 0;
    },

    async pruneBuckets(granularity, keepDays) {
      const cutoff = new Date(Date.now() - keepDays * 86_400_000);
      const deleted = await db
        .delete(usageBuckets)
        .where(and(eq(usageBuckets.granularity, granularity), lt(usageBuckets.bucketStart, cutoff)))
        .returning({ id: usageBuckets.id });
      return deleted.length;
    },
  };
}

/** Maps a stored (aliased raw or typed) row to the wire row shape. */
function rowToRequest(raw: Record<string, unknown>): UsageRequestRow {
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
  const real = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const dateMs = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
  return {
    id: String(raw.id),
    nodeId: String(raw.nodeId),
    setupId: str(raw.setupId),
    port: int(raw.port) ?? 0,
    ts: dateMs(raw.ts),
    model: str(raw.model),
    endpoint: String(raw.endpoint),
    stream: raw.stream === true,
    status: int(raw.status),
    finishReason: str(raw.finishReason),
    error: str(raw.error),
    errorSig: str(raw.errorSig),
    durationMs: int(raw.durationMs),
    ttftMs: int(raw.ttftMs),
    decodeTps: real(raw.decodeTps),
    promptTokens: int(raw.promptTokens),
    completionTokens: int(raw.completionTokens),
    cachedTokens: int(raw.cachedTokens),
    reasoningTokens: int(raw.reasoningTokens),
    totalTokens: int(raw.totalTokens),
    engineMeta: raw.engineMeta === null || raw.engineMeta === undefined ? null : (raw.engineMeta as Record<string, unknown>),
    reqBytes: int(raw.reqBytes) ?? 0,
    resBytes: int(raw.resBytes) ?? 0,
    sourceAddr: str(raw.sourceAddr),
    parts: [],
    respTools: [],
    toolResults: [],
    clientKeyHash: str(raw.clientKeyHash),
    clientName: str(raw.clientName),
    clientProject: str(raw.clientProject),
    clientAgentType: raw.clientAgentType === "main" || raw.clientAgentType === "subagent" ? raw.clientAgentType : null,
    retryAttempt: int(raw.retryAttempt),
    retryKind: str(raw.retryKind),
    retryStatus: str(raw.retryStatus),
    retrySupersededBy: str(raw.retrySupersededBy),
    receivedAtMs: dateMs(raw.receivedAt),
  };
}
