import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@irori/db";
import { nodes, setups, tokenLedger } from "@irori/db";
import {
  analyticsGranularity,
  analyticsRangeMs,
  tokenMacroResponseSchema,
  type AnalyticsRangeValue,
  type TokenMacroResponse,
} from "@irori/core";
import { toWorkerIds } from "./analytics.js";

/**
 * Token macro views (IRI-040 / IR-118): fleet, per serving cluster, per node,
 * per model — read-time aggregation over the M7 token ledger (engine lifetime
 * counters via the agent probes; the capture proxy is never involved).
 *
 * Sums always cover the WHOLE ledger for the range at the lens granularity —
 * never a top-N subset. `total = generated + input` and
 * `cacheHitPct = cached / input × 100` (0 when input is 0) mirror the
 * SparkDash-derived metrics the owner asked for; the rendering is Irori's own.
 */
export interface TokenMacroQuery {
  range: AnalyticsRangeValue;
}

export interface TokenMacroService {
  build(query: TokenMacroQuery): Promise<TokenMacroResponse>;
}

interface Sums {
  gen: number;
  prompt: number;
  cached: number;
}

function row(sums: Sums): { total: number; generated: number; input: number; cached: number; cacheHitPct: number } {
  const generated = Math.round(sums.gen);
  const input = Math.round(sums.prompt);
  const cached = Math.round(sums.cached);
  return {
    total: generated + input,
    generated,
    input,
    cached,
    cacheHitPct: input > 0 ? Math.round((cached / input) * 1000) / 10 : 0,
  };
}

export function createTokenMacroService(db: Db): TokenMacroService {
  return {
    async build({ range }): Promise<TokenMacroResponse> {
      const granularity = analyticsGranularity("tokens", range);
      const since = new Date(Date.now() - analyticsRangeMs(range));

      // One grouped read; per-node-per-model sums fold into every view below.
      const rows = await db
        .select({
          nodeId: tokenLedger.nodeId,
          model: tokenLedger.model,
          gen: sql<number>`sum(${tokenLedger.generatedTokens})::float8`,
          prompt: sql<number>`sum(${tokenLedger.promptTokens})::float8`,
          cached: sql<number>`sum(${tokenLedger.cachedTokens})::float8`,
        })
        .from(tokenLedger)
        .where(and(eq(tokenLedger.granularity, granularity), gte(tokenLedger.bucketStart, since)))
        .groupBy(tokenLedger.nodeId, tokenLedger.model);

      const [nodeRows, setupRows] = await Promise.all([
        db.select({ id: nodes.id, name: nodes.name }).from(nodes),
        db.select({ id: setups.id, name: setups.name, headNodeId: setups.headNodeId, nodes: setups.nodes }).from(setups),
      ]);

      const fleet: Sums = { gen: 0, prompt: 0, cached: 0 };
      const perNode = new Map<string, Sums>();
      const perModel = new Map<string, Sums>();
      for (const r of rows) {
        const sums: Sums = { gen: r.gen ?? 0, prompt: r.prompt ?? 0, cached: r.cached ?? 0 };
        fleet.gen += sums.gen;
        fleet.prompt += sums.prompt;
        fleet.cached += sums.cached;
        const n = perNode.get(r.nodeId) ?? { gen: 0, prompt: 0, cached: 0 };
        n.gen += sums.gen;
        n.prompt += sums.prompt;
        n.cached += sums.cached;
        perNode.set(r.nodeId, n);
        const m = perModel.get(r.model) ?? { gen: 0, prompt: 0, cached: 0 };
        m.gen += sums.gen;
        m.prompt += sums.prompt;
        m.cached += sums.cached;
        perModel.set(r.model, m);
      }

      const nodeNames = new Map(nodeRows.map((n) => [n.id, n.name]));
      // Cluster membership — same setup semantics as the analytics lens: head
      // plus worker node ids; a node in several setups folds under its first.
      const clusterOf = new Map<string, { id: string; name: string }>();
      for (const s of setupRows) {
        const label = { id: s.id, name: s.name };
        for (const id of [s.headNodeId, ...toWorkerIds(s.nodes)]) {
          if (!clusterOf.has(id)) clusterOf.set(id, label);
        }
      }
      const perCluster = new Map<string, { label: { id: string; name: string }; sums: Sums }>();
      const standalone: Sums = { gen: 0, prompt: 0, cached: 0 };
      let standaloneHas = false;
      for (const [nodeId, sums] of perNode) {
        const cluster = clusterOf.get(nodeId);
        if (cluster === undefined) {
          standalone.gen += sums.gen;
          standalone.prompt += sums.prompt;
          standalone.cached += sums.cached;
          standaloneHas = true;
          continue;
        }
        const c = perCluster.get(cluster.id) ?? { label: cluster, sums: { gen: 0, prompt: 0, cached: 0 } };
        c.sums.gen += sums.gen;
        c.sums.prompt += sums.prompt;
        c.sums.cached += sums.cached;
        perCluster.set(cluster.id, c);
      }

      const byTotalDesc = (a: Sums, b: Sums): number => b.gen + b.prompt - (a.gen + a.prompt);
      const clusters = [...perCluster.values()]
        .sort((a, b) => byTotalDesc(a.sums, b.sums))
        .map((c) => ({ id: c.label.id, name: c.label.name, ...row(c.sums) }));
      // Standalone nodes (in no setup) surface as their own cluster-like row
      // so the By-cluster view is complete — only when they carry tokens.
      if (standaloneHas) clusters.push({ id: "standalone", name: "standalone", ...row(standalone) });

      const nodeList = [...perNode.entries()]
        .sort((a, b) => byTotalDesc(a[1], b[1]))
        .map(([id, sums]) => ({ id, name: nodeNames.get(id) ?? id, cluster: clusterOf.get(id)?.name ?? null, ...row(sums) }));

      const models = [...perModel.entries()]
        .sort((a, b) => byTotalDesc(a[1], b[1]))
        .slice(0, 100)
        .map(([model, sums]) => ({ model, ...row(sums) }));

      return tokenMacroResponseSchema.parse({ range, fleet: row(fleet), clusters, nodes: nodeList, models });
    },
  };
}
