import type { Express, Response } from "express";
import type { AuditService } from "./audit.js";
import { audit } from "./audit-routes.js";
import type { NetworkService } from "./network-service.js";
import { networkSettingsPatchSchema, type NetworkSettingsService } from "./network-settings.js";
import type { NetLiveService } from "./network-live.js";
import { netLiveLeaseRequestSchema, networkTestAllRequestSchema, networkTestRequestSchema } from "@irori/core";
import type { NetworkTestsService } from "./network-tests.js";
import { HISTORY_RANGES, type HistoryRange, type LinkHistory } from "./network-history.js";

/**
 * IRI-162+ (ADR-0021): the network routes. Degraded hubs (no DB) answer 503
 * like every other store-backed route. Mutating routes carry the audit
 * marker (IRI-077 coverage test).
 */
export interface NetworkRouteDeps {
  getNetwork: () => NetworkService | null;
  getSettings: () => NetworkSettingsService | null;
  onSettingsChanged: () => void;
  getAudit: () => AuditService | null;
  getLive: () => NetLiveService | null;
  getTests: () => NetworkTestsService | null;
  getHistory: () => LinkHistory | null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LINK_ID_RE = new RegExp(`^${UUID}\\|${UUID}$`, "i");

export function registerNetworkRoutes(app: Express, deps: NetworkRouteDeps): void {
  const requireNetwork = (res: Response): NetworkService | null => {
    const svc = deps.getNetwork();
    if (svc === null) res.status(503).json({ error: "network service unavailable" });
    return svc;
  };
  const requireSettings = (res: Response): NetworkSettingsService | null => {
    const svc = deps.getSettings();
    if (svc === null) res.status(503).json({ error: "database unavailable" });
    return svc;
  };

  app.get("/api/v1/network/topology", async (_req, res) => {
    const svc = requireNetwork(res);
    if (svc === null) return;
    try {
      res.json(await svc.topology());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // IRI-164: leased live rates. Taking and ending a lease is audited; a
  // renewal (every 30 s while the card is visible) is not — it would bury
  // the record, and it changes nothing but an expiry.
  app.get("/api/v1/network/live", (_req, res) => {
    const live = deps.getLive();
    if (live === null) return res.status(503).json({ error: "network service unavailable" });
    res.json(live.status());
  });

  app.post(
    "/api/v1/network/live",
    audit(
      {
        action: "network.live.start",
        targetType: "network",
        targetId: () => "live",
        skip: (req) => {
          const body: unknown = req.body;
          return body !== null && typeof body === "object" && "leaseId" in body;
        },
      },
      deps.getAudit,
    ),
    (req, res) => {
      const live = deps.getLive();
      if (live === null) return res.status(503).json({ error: "network service unavailable" });
      const body = netLiveLeaseRequestSchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "intervalMs must be 1000, 500 or 250", issues: body.error.issues });
      const out = live.acquire(body.data.intervalMs, body.data.leaseId);
      if (!out.ok) {
        if (out.reason === "disabled") return res.status(409).json({ error: "live mode is disabled in the network settings" });
        return res.status(410).json({ error: out.reason === "lease-ended" ? "the lease reached its 10-minute limit" : "unknown or expired lease", reason: out.reason });
      }
      res.json(out.lease);
    },
  );

  app.delete(
    "/api/v1/network/live/:id",
    audit({ action: "network.live.stop", targetType: "network", targetId: () => "live" }, deps.getAudit),
    (req, res) => {
      const live = deps.getLive();
      if (live === null) return res.status(503).json({ error: "network service unavailable" });
      const id = typeof req.params.id === "string" ? req.params.id : "";
      live.release(id);
      res.status(204).end();
    },
  );

  // IRI-166: on-demand link tests. Starting one is audited; the run's
  // progress and result are journaled through the `network-test` SSE frames.
  const requireTests = (res: Response): NetworkTestsService | null => {
    const svc = deps.getTests();
    if (svc === null) res.status(503).json({ error: "database unavailable" });
    return svc;
  };

  app.get("/api/v1/network/tests", async (req, res) => {
    const svc = requireTests(res);
    if (svc === null) return;
    const limit = Number.parseInt(String(req.query.limit ?? "50"), 10);
    res.json({ tests: await svc.list(Number.isFinite(limit) ? limit : 50), running: svc.busy() });
  });

  app.post(
    "/api/v1/network/tests",
    audit({ action: "network.test.start", targetType: "network", targetId: (req) => {
      const body: unknown = req.body;
      return body && typeof body === "object" && "aNodeId" in body && "bNodeId" in body ? `${String(body.aNodeId)}→${String(body.bNodeId)}` : null;
    } }, deps.getAudit),
    async (req, res) => {
      const svc = requireTests(res);
      if (svc === null) return;
      const body = networkTestRequestSchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "invalid link test request", issues: body.error.issues });
      const out = await svc.start(body.data);
      if (!out.ok) return res.status(out.status).json({ error: out.error, ...(out.reasons === undefined ? {} : { reasons: out.reasons }) });
      res.status(202).json(out.test);
    },
  );

  app.post(
    "/api/v1/network/tests/all",
    audit({ action: "network.test.all", targetType: "network", targetId: () => "all" }, deps.getAudit),
    async (req, res) => {
      const svc = requireTests(res);
      if (svc === null) return;
      const body = networkTestAllRequestSchema.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ error: "invalid link test request", issues: body.error.issues });
      const out = await svc.startAll(body.data);
      if (!out.ok) return res.status(out.status).json({ error: out.error, ...(out.reasons === undefined ? {} : { reasons: out.reasons }) });
      res.status(202).json({ links: out.links });
    },
  );

  // IRI-168: per-link minute history (7 days), binned per range.
  app.get("/api/v1/network/links/:linkId/history", async (req, res) => {
    const history = deps.getHistory();
    if (history === null) return res.status(503).json({ error: "database unavailable" });
    const linkId = typeof req.params.linkId === "string" ? req.params.linkId : "";
    if (!LINK_ID_RE.test(linkId)) return res.status(400).json({ error: "invalid link id" });
    const range = String(req.query.range ?? "24h");
    if (!Object.hasOwn(HISTORY_RANGES, range)) return res.status(400).json({ error: "range must be 1h, 24h or 7d" });
    res.json({ linkId, range, points: await history.query(linkId, range as HistoryRange) });
  });

  app.get("/api/v1/settings/network", async (_req, res) => {
    const svc = requireSettings(res);
    if (svc === null) return;
    res.json(await svc.get());
  });

  app.put(
    "/api/v1/settings/network",
    audit({ action: "settings.network.put", targetType: "settings", targetId: () => "network" }, deps.getAudit),
    async (req, res) => {
      const svc = requireSettings(res);
      if (svc === null) return;
      const body = networkSettingsPatchSchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "invalid network settings", issues: body.error.issues });
      const next = await svc.set(body.data);
      deps.onSettingsChanged();
      res.json(next);
    },
  );
}
