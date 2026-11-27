import { lt, sql } from "drizzle-orm";
import { linkRates, type HardwareSnapshot, type Topology } from "@irori/core";
import { networkLinkMinutes } from "@irori/db";
import type { Db } from "@irori/db";

/**
 * IRI-168 (ADR-0021): per-link history. Every SAMPLE_MS the hub reads each
 * link's live rates (node a's side, the card's own formula) and prober RTT
 * from the latest snapshots, folds them into the current minute in memory,
 * and writes the finished minute as one row per link. Seven days are kept.
 * Losing the partial minute on a hub restart is accepted (history, not audit).
 */

export const SAMPLE_MS = 10_000;
export const KEEP_MS = 7 * 86_400_000;
const MINUTE_MS = 60_000;

export const HISTORY_RANGES = { "1h": { spanMs: 3_600_000, binS: 60 }, "24h": { spanMs: 86_400_000, binS: 300 }, "7d": { spanMs: KEEP_MS, binS: 1800 } } as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;

export interface LinkMinuteRow {
  linkId: string;
  aNodeId: string;
  bNodeId: string;
  bucketStart: Date;
  txBpsAvg: number | null;
  rxBpsAvg: number | null;
  txBpsMax: number | null;
  rxBpsMax: number | null;
  rttMsAvg: number | null;
  lossPctAvg: number | null;
  samples: number;
}

export interface LinkHistoryPoint {
  t: string;
  txBps: number | null;
  rxBps: number | null;
  txMaxBps: number | null;
  rxMaxBps: number | null;
  rttMs: number | null;
  lossPct: number | null;
}

export interface LinkHistoryStore {
  write(rows: LinkMinuteRow[]): Promise<void>;
  query(linkId: string, since: Date, binS: number): Promise<LinkHistoryPoint[]>;
  prune(before: Date): Promise<number>;
}

interface Acc {
  aNodeId: string;
  bNodeId: string;
  tx: number[];
  rx: number[];
  rtt: number[];
  loss: number[];
  samples: number;
}

const avg = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
const max = (xs: number[]): number | null => (xs.length === 0 ? null : Math.max(...xs));

export interface LinkHistoryDeps {
  store: LinkHistoryStore;
  topology: () => Promise<Topology>;
  latest: (nodeId: string) => HardwareSnapshot | undefined;
  now?: () => number;
  log?: (m: string) => void;
}

export interface LinkHistory {
  /** One sample of every link; writes the previous minute when it rolled over. */
  sample(): Promise<void>;
  query(linkId: string, range: HistoryRange): Promise<LinkHistoryPoint[]>;
  prune(): Promise<number>;
}

export function createLinkHistory(deps: LinkHistoryDeps): LinkHistory {
  const now = deps.now ?? Date.now;
  let minute: number | null = null;
  let acc = new Map<string, Acc>();

  async function flush(bucket: number, data: Map<string, Acc>): Promise<void> {
    const rows: LinkMinuteRow[] = [...data].map(([linkId, a]) => ({
      linkId,
      aNodeId: a.aNodeId,
      bNodeId: a.bNodeId,
      bucketStart: new Date(bucket),
      txBpsAvg: avg(a.tx),
      rxBpsAvg: avg(a.rx),
      txBpsMax: max(a.tx),
      rxBpsMax: max(a.rx),
      rttMsAvg: avg(a.rtt),
      lossPctAvg: avg(a.loss),
      samples: a.samples,
    }));
    if (rows.length > 0) await deps.store.write(rows);
  }

  return {
    async sample() {
      const t = now();
      const bucket = Math.floor(t / MINUTE_MS) * MINUTE_MS;
      if (minute !== null && bucket !== minute) {
        const done = acc;
        const doneMinute = minute;
        acc = new Map();
        await flush(doneMinute, done).catch((err) => deps.log?.(`[irori-server] link history write failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      minute = bucket;
      const topology = await deps.topology();
      for (const link of topology.links) {
        const a = acc.get(link.id) ?? { aNodeId: link.a, bNodeId: link.b, tx: [], rx: [], rtt: [], loss: [], samples: 0 };
        const rates = linkRates(link, deps.latest(link.a)?.network);
        if (rates.txBps !== null) a.tx.push(rates.txBps);
        if (rates.rxBps !== null) a.rx.push(rates.rxBps);
        const probes = link.lanes.filter((l) => l.up && l.probe !== null).map((l) => l.probe!);
        const rtts = probes.map((p) => p.rttAvgMs).filter((r): r is number => r !== null);
        if (rtts.length > 0) a.rtt.push(Math.max(...rtts));
        if (probes.length > 0) a.loss.push(Math.max(...probes.map((p) => p.lossPct)));
        a.samples += 1;
        acc.set(link.id, a);
      }
    },
    async query(linkId, range) {
      const r = HISTORY_RANGES[range];
      return deps.store.query(linkId, new Date(now() - r.spanMs), r.binS);
    },
    prune: () => deps.store.prune(new Date(now() - KEEP_MS)),
  };
}

export function createLinkHistoryStore(db: Db): LinkHistoryStore {
  return {
    async write(rows) {
      await db
        .insert(networkLinkMinutes)
        .values(rows)
        .onConflictDoUpdate({
          target: [networkLinkMinutes.linkId, networkLinkMinutes.bucketStart],
          set: {
            txBpsAvg: sql`excluded.tx_bps_avg`,
            rxBpsAvg: sql`excluded.rx_bps_avg`,
            txBpsMax: sql`excluded.tx_bps_max`,
            rxBpsMax: sql`excluded.rx_bps_max`,
            rttMsAvg: sql`excluded.rtt_ms_avg`,
            lossPctAvg: sql`excluded.loss_pct_avg`,
            samples: sql`excluded.samples`,
          },
        });
    },
    async query(linkId, since, binS) {
      // Version-independent binning (no date_bin): floor(epoch / bin) * bin.
      // Raw sql: postgres-js binds a Date only through the query builder, so ISO + cast.
      const rows = (await db.execute(sql`
        SELECT to_timestamp(floor(extract(epoch FROM bucket_start) / ${binS}) * ${binS}) AS t,
               avg(tx_bps_avg) AS tx, avg(rx_bps_avg) AS rx,
               max(tx_bps_max) AS tx_max, max(rx_bps_max) AS rx_max,
               avg(rtt_ms_avg) AS rtt, avg(loss_pct_avg) AS loss
        FROM network_link_minutes
        WHERE link_id = ${linkId} AND bucket_start >= ${since.toISOString()}::timestamptz
        GROUP BY 1 ORDER BY 1
      `)) as unknown as Array<{ t: Date | string; tx: unknown; rx: unknown; tx_max: unknown; rx_max: unknown; rtt: unknown; loss: unknown }>;
      const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
      return rows.map((r) => ({
        t: new Date(r.t).toISOString(),
        txBps: num(r.tx),
        rxBps: num(r.rx),
        txMaxBps: num(r.tx_max),
        rxMaxBps: num(r.rx_max),
        rttMs: num(r.rtt),
        lossPct: num(r.loss),
      }));
    },
    async prune(before) {
      const out = await db.delete(networkLinkMinutes).where(lt(networkLinkMinutes.bucketStart, before)).returning({ linkId: networkLinkMinutes.linkId });
      return out.length;
    },
  };
}
