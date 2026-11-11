import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret, healthFindings, healthRules, secrets, settings, type Db } from "@irori/db";
import { HEALTH_SEED_RULES, healthRuleSchema, type HealthFinding, type HealthRule, type HealthThresholds } from "@irori/core";
import type { HardwareSnapshot } from "@irori/core";
import type { SseEvent } from "@irori/core";
import type { EventJournalService } from "./event-journal.js";

/**
 * IRI-069: server-side health rules engine. Rules are evaluated on snapshot
 * ingest (plus a periodic offline/gap sweep); appear/clear transitions write
 * durable journal events; per-rule webhooks enforce a cooldown and record
 * delivery rows. The webhook URL lives encrypted in `secrets` (ADR-0002).
 */

export interface HealthSinks {
  sse: (event: SseEvent) => void;
  journal: (event: SseEvent) => Promise<void>;
  /** IR-179: per-node journal counts for the reconnect-storm rule. */
  journalCounts?: (type: string, sinceMs: number) => Promise<Array<{ nodeId: string | null; n: number }>>;
  /**
   * IR-189: consecutive sweeps in which the node's live clock ceiling differs
   * from the stored cap (0 = matching, null = not measurable). Absence skips
   * the rule (tests, no clock-cap service wired).
   */
  clockDrift?: (nodeId: string) => Promise<number | null>;
  /**
   * IR-201: the hub's own filesystem usage in percent (null = not
   * measurable). Absence skips the rule (tests, gauge not wired).
   */
  hubDiskPct?: () => Promise<number | null>;
  /**
   * IR-202: database availability (true = reachable). The db client's
   * isHealthy() resolves false while the DB is down; a rejected promise is
   * treated as not measurable. Absence skips the rule (older harnesses).
   */
  dbHealthy?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const SEED_BY_NAME = new Map(HEALTH_SEED_RULES.map((r) => [r.name, r]));

/** Metric value from one snapshot; null = not measurable (rule skipped). */
export function metricValue(metric: string, snapshot: HardwareSnapshot): number | null {
  switch (metric) {
    case "gpu_temp_c": {
      const temps = snapshot.gpus.map((g) => g.tempC).filter((t): t is number => t !== null);
      return temps.length > 0 ? Math.max(...temps) : null;
    }
    case "disk_pct": {
      const pcts = snapshot.storage
        .filter((s) => s.totalBytes > 0)
        .map((s) => (s.usedBytes / s.totalBytes) * 100);
      return pcts.length > 0 ? Math.max(...pcts) : null;
    }
    case "kernel_xid":
      return snapshot.kernel?.xidCount ?? null;
    case "throttle_active":
      return snapshot.gpus.some((g) => g.throttleReasons.length > 0) ? 1 : 0;
    case "power_w":
      return snapshot.cpu.packagePowerW;
    default:
      return null;
  }
}

/** op comparison; null operand never breaches. */
export function breaches(op: string, value: number | null, threshold: number): boolean {
  if (value === null) return false;
  switch (op) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
    default:
      return false;
  }
}

function summaryFor(rule: { name: string; metric: string; op: string; threshold: number }, value: number | null): string {
  const v = value === null ? "?" : Math.round(value * 10) / 10;
  return `${rule.name}: ${v} ${opSymbol(rule.op)} ${rule.threshold}`;
}

function opSymbol(op: string): string {
  return { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" }[op] ?? op;
}

export interface HealthService {
  ensureSeed(): Promise<void>;
  listRules(): Promise<HealthRule[]>;
  setRule(id: string, put: Record<string, unknown>): Promise<HealthRule | null>;
  thresholds(): Promise<HealthThresholds>;
  /** Evaluate present-snapshot rules; fire-and-forget from the ingest path. */
  onSnapshot(nodeId: string, snapshot: HardwareSnapshot): Promise<void>;
  /** Offline + telemetry-gap rules over the whole fleet (30 s cadence). */
  sweep(nodes: Array<{ id: string; name: string }>, onlineIds: ReadonlySet<string>, lastSeen: ReadonlyMap<string, number>): Promise<void>;
  findings(): Promise<HealthFinding[]>;
  metricsEnabled(): Promise<boolean>;
  setMetricsEnabled(v: boolean): Promise<void>;
  /** Latest snapshot per node for the /metrics renderer. */
  latest: Map<string, HardwareSnapshot>;
}

export function createHealthService(db: Db, encryptionKey: string, opts: HealthSinks): HealthService {
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const latest = new Map<string, HardwareSnapshot>();

  async function ruleRows() {
    return db.select().from(healthRules).orderBy(healthRules.createdAt);
  }

  function toWire(row: typeof healthRules.$inferSelect): HealthRule {
    return healthRuleSchema.parse({
      id: row.id,
      name: row.name,
      metric: row.metric,
      op: row.op,
      threshold: row.threshold,
      severity: row.severity,
      scope: row.scope,
      cooldownSec: row.cooldownSec,
      enabled: row.enabled,
      hasWebhook: false, // replaced below for channel rows
    });
  }

  async function webhookUrlFor(ruleId: string): Promise<string | null> {
    const rows = await db.select().from(secrets).where(eq(secrets.name, `health:webhook:${ruleId}`)).limit(1);
    if (rows.length === 0 || rows[0]!.valueEnc === null) return null;
    try {
      return decryptSecret(encryptionKey, rows[0]!.valueEnc);
    } catch {
      return null;
    }
  }

  async function emit(event: Extract<SseEvent, { type: "health" }>): Promise<void> {
    opts.sse(event);
    await opts.journal(event);
  }

  interface RuleRef {
    id: string;
    name: string;
    metric: string;
    severity: string;
    url: string | null;
  }

  async function notify(
    rule: RuleRef,
    nodeId: string | null,
    kind: "appear" | "clear",
    summary: string,
    value: number | null,
  ): Promise<void> {
    if (rule.url === null) return;
    let ok = false;
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetchImpl(rule.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule: rule.name, metric: rule.metric, severity: rule.severity, state: kind, nodeId, summary, observed: value, at: new Date(now()).toISOString() }),
      });
      status = res.status;
      ok = res.ok;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    }
    // Delivery result recorded (best effort — a failed write must not break ingest).
    try {
      await db.execute(
        // alert_deliveries insert; channel resolved by rule below via SQL.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sql`insert into alert_deliveries (channel_id, rule_id, node_id, kind, ok, status, error)
          select c.id, ${rule.id}::uuid, ${nodeId}::uuid, ${kind}, ${ok}, ${status}, ${error}
          from alert_channels c where c.rule_id = ${rule.id}::uuid limit 1`,
      );
    } catch {
      // Table may not exist in old schemas — the journal event still lands.
    }
  }

  async function transition(
    rule: { id: string; name: string; metric: string; op: string; threshold: number; severity: string; cooldownSec: number; url: string | null } & RuleRef,
    nodeId: string | null,
    kind: "appear" | "clear",
    value: number | null,
  ): Promise<void> {
    const summary = kind === "appear" ? summaryFor(rule, value) : `${rule.name}: cleared`;
    await emit({ type: "health", serverTimeMs: now(), nodeId, ruleId: rule.id, ruleName: rule.name, metric: rule.metric, severity: rule.severity, state: kind === "appear" ? "open" : "clear", summary });
    // Cooldown applies to appear notifications only (a clear is always sent).
    if (kind === "appear" && rule.url !== null) {
      await notify({ ...rule, url: rule.url }, nodeId, "appear", summary, value);
    } else if (kind === "clear") {
      await notify({ ...rule, url: rule.url }, nodeId, "clear", summary, value);
    }
  }

  interface RuleRow {
    id: string;
    name: string;
    metric: string;
    op: string;
    threshold: number | null;
    severity: string;
    cooldownSec: number;
  }

  /**
   * Applies one rule to one node: open a finding on the first breach, re-notify
   * inside an open finding once the cooldown elapses, clear when the value
   * recovers. The webhook URL is read only on a transition — this runs on every
   * snapshot for every node-scoped rule, so a per-evaluation secret read would
   * be a hot-path query. `nodeId === null` marks a fleet-scoped finding (the
   * hub itself, IR-201) — the lookup must use IS NULL, `eq(col, null)` never
   * matches.
   */
  async function evaluate(rule: RuleRow, nodeId: string | null, value: number): Promise<void> {
    const breach = breaches(rule.op, value, rule.threshold ?? 0);
    const open = await db
      .select()
      .from(healthFindings)
      .where(
        and(
          eq(healthFindings.ruleId, rule.id),
          nodeId === null ? isNull(healthFindings.nodeId) : eq(healthFindings.nodeId, nodeId),
          isNull(healthFindings.clearedAt),
        ),
      )
      .limit(1);
    const ref = {
      id: rule.id,
      name: rule.name,
      metric: rule.metric,
      op: rule.op,
      threshold: rule.threshold ?? 0,
      severity: rule.severity,
      cooldownSec: rule.cooldownSec,
      url: null as string | null,
    };
    if (breach && open.length === 0) {
      await db.insert(healthFindings).values({ ruleId: rule.id, nodeId, observedValue: value, lastNotifiedAt: new Date(now()) });
      ref.url = await webhookUrlFor(rule.id);
      await transition(ref, nodeId, "appear", value);
    } else if (breach && open.length > 0) {
      const last = open[0]!.lastNotifiedAt?.getTime() ?? 0;
      if (now() - last > rule.cooldownSec * 1000) {
        ref.url = await webhookUrlFor(rule.id);
        if (ref.url !== null) {
          await db.update(healthFindings).set({ lastNotifiedAt: new Date(now()) }).where(eq(healthFindings.id, open[0]!.id));
          await notify(ref, nodeId, "appear", summaryFor(ref, value), value);
        }
      }
    } else if (!breach && open.length > 0) {
      await db.update(healthFindings).set({ clearedAt: new Date(now()) }).where(eq(healthFindings.id, open[0]!.id));
      ref.url = await webhookUrlFor(rule.id);
      await transition(ref, nodeId, "clear", value);
    }
  }

  const service: HealthService = {
    latest,
    async ensureSeed() {
      for (const seed of HEALTH_SEED_RULES) {
        await db
          .insert(healthRules)
          .values({
            seed: seed.name,
            name: seed.name,
            metric: seed.metric,
            op: seed.op,
            threshold: seed.threshold,
            severity: seed.severity,
            scope: seed.scope ?? "node",
            cooldownSec: seed.cooldownSec,
            enabled: true,
          })
          .onConflictDoNothing();
      }
    },
    async listRules() {
      const rows = await ruleRows();
      const out: HealthRule[] = [];
      for (const row of rows) {
        const wire = toWire(row);
        out.push({ ...wire, hasWebhook: (await webhookUrlFor(row.id)) !== null });
      }
      return out;
    },
    async setRule(id, put) {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (put.name !== undefined) patch.name = put.name;
      if (put.threshold !== undefined) patch.threshold = put.threshold;
      if (put.severity !== undefined) patch.severity = put.severity;
      if (put.cooldownSec !== undefined) patch.cooldownSec = put.cooldownSec;
      if (put.enabled !== undefined) patch.enabled = put.enabled;
      await db.update(healthRules).set(patch).where(eq(healthRules.id, id));
      if (put.webhookUrl !== undefined) {
        if (put.webhookUrl === null) {
          await db.delete(secrets).where(eq(secrets.name, `health:webhook:${id}`));
        } else if (typeof put.webhookUrl === "string") {
          const enc = encryptSecret(encryptionKey, put.webhookUrl);
          await db
            .insert(secrets)
            .values({ name: `health:webhook:${id}`, valueEnc: enc })
            .onConflictDoUpdate({ target: secrets.name, set: { valueEnc: enc } });
          await db.execute(
            sql`insert into alert_channels (id, name, rule_id, enabled)
              values (gen_random_uuid(), ${"webhook:" + id}, ${id}::uuid, true)
              on conflict do nothing`,
          ).catch(() => {});
        }
      }
      const rows = await db.select().from(healthRules).where(eq(healthRules.id, id)).limit(1);
      if (rows.length === 0) return null;
      const wire = toWire(rows[0]!);
      return { ...wire, hasWebhook: (await webhookUrlFor(id)) !== null };
    },
    async thresholds() {
      // Live thresholds come from the seeded rules the operator may have
      // tuned; falls back to the seed constants when a rule is missing.
      const rows = await ruleRows();
      const bySeed = new Map(rows.map((r) => [r.seed, r]));
      const gpuWarn = bySeed.get("GPU temp warn")?.threshold ?? 70;
      const gpuCritical = bySeed.get("GPU temp critical")?.threshold ?? 90;
      const disk = bySeed.get("Disk usage warn")?.threshold ?? 80;
      const hubDisk = bySeed.get("Hub disk warn")?.threshold ?? 80;
      const db = bySeed.get("Database unavailable")?.threshold ?? 1;
      return { tempWarnC: gpuWarn ?? 70, tempCriticalC: gpuCritical ?? 90, diskWarnPct: disk ?? 80, hubDiskWarnPct: hubDisk ?? 80, dbUnavailable: db };
    },
    async onSnapshot(nodeId, snapshot) {
      latest.set(nodeId, snapshot);
      const rules = (await ruleRows()).filter((r) => r.enabled && r.scope === "node");
      for (const row of rules) {
        const value = metricValue(row.metric, snapshot);
        if (value === null) continue;
        await evaluate(row, nodeId, value);
      }
    },
    async sweep(nodes, onlineIds, lastSeen) {
      const rules = (await ruleRows()).filter((r) => r.enabled);
      const offlineRule = rules.find((r) => r.metric === "node_offline");
      const gapRule = rules.find((r) => r.metric === "telemetry_gap_s");
      for (const node of nodes) {
        const online = onlineIds.has(node.id);
        const gapS = Math.round(((now() - (lastSeen.get(node.id) ?? now())) / 1000) * 10) / 10;
        for (const rule of [offlineRule, gapRule]) {
          if (rule === undefined) continue;
          await evaluate(rule, node.id, rule.metric === "node_offline" ? (online ? 0 : 1) : gapS);
        }
      }
      // IR-179: reconnect-storm rule — node-online journal events per node in
      // a 5 min window. A 30 s crash loop lands at ~10; deploy blips stay
      // silent. Reader absence (tests, journaling disabled) skips the rule.
      const stormRule = rules.find((r) => r.metric === "reconnect_storm");
      if (stormRule !== undefined && opts.journalCounts !== undefined) {
        const counts = await opts.journalCounts("node-online", 5 * 60_000).catch(() => []);
        const byNode = new Map(counts.map((c) => [c.nodeId, c.n]));
        for (const node of nodes) await evaluate(stormRule, node.id, byNode.get(node.id) ?? 0);
      }
      // IR-189: clock-cap drift — consecutive sweeps whose live ceiling differs
      // from the cap stored on the node. Only online nodes are measurable: the
      // reading is a request/response over the agent socket.
      const driftRule = rules.find((r) => r.metric === "clock_cap_drift");
      if (driftRule !== undefined && opts.clockDrift !== undefined) {
        for (const node of nodes) {
          if (!onlineIds.has(node.id)) continue;
          const value = await opts.clockDrift(node.id).catch(() => null);
          if (value === null) continue;
          await evaluate(driftRule, node.id, value);
        }
      }
      // IR-201: the hub-disk rule reads the hub's own filesystem once per
      // sweep — a null gauge (statfs failure) means not measurable, exactly
      // like an agent that cannot read its disks.
      const hubRule = rules.find((r) => r.metric === "hub_disk_pct");
      if (hubRule !== undefined && opts.hubDiskPct !== undefined) {
        const value = await opts.hubDiskPct().catch(() => null);
        if (value !== null) await evaluate(hubRule, null, value);
      }
      // IR-202: the database rule reuses the db client's isHealthy() boolean
      // (the same one /healthz reports) once per sweep — never per request. A
      // rejected ping is treated as not measurable, exactly like a failed
      // statfs gauge.
      const dbRule = rules.find((r) => r.metric === "db_unavailable");
      if (dbRule !== undefined && opts.dbHealthy !== undefined) {
        const value = await opts.dbHealthy().then((h) => (h ? 0 : 1)).catch(() => null);
        if (value !== null) await evaluate(dbRule, null, value);
      }
    },
    async findings() {
      const rows = await db
        .select({ f: healthFindings, rule: healthRules })
        .from(healthFindings)
        .innerJoin(healthRules, eq(healthFindings.ruleId, healthRules.id))
        .where(isNull(healthFindings.clearedAt))
        .orderBy(desc(healthFindings.since))
        .limit(200);
      return rows.map(({ f, rule }) => ({
        nodeId: f.nodeId ?? "",
        ruleId: rule.id,
        metric: rule.metric as HealthFinding["metric"],
        severity: rule.severity as HealthFinding["severity"],
        summary: `${rule.name}: ${f.observedValue === null ? "?" : Math.round(f.observedValue * 10) / 10} ${opSymbol(rule.op)} ${rule.threshold ?? "?"}`,
        since: f.since.toISOString(),
      }));
    },
    async metricsEnabled() {
      const rows = await db.select().from(settings).where(eq(settings.key, "metrics_enabled")).limit(1);
      return rows[0]?.value === true;
    },
    async setMetricsEnabled(v) {
      await db.execute(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sql`insert into settings (key, value) values ('metrics_enabled', ${v ? "true" : "false"})
          on conflict (key) do update set value = ${v ? "true" : "false"}`,
      );
    },
  };
  return service;
}
