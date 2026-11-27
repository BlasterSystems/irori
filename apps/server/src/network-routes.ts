import type { Express, Response } from "express";
import type { AuditService } from "./audit.js";
import { audit } from "./audit-routes.js";
import type { NetworkService } from "./network-service.js";
import { networkSettingsPatchSchema, type NetworkSettingsService } from "./network-settings.js";
import type { NetLiveService } from "./network-live.js";
import { netLiveLeaseRequestSchema } from "@irori/core";

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
}

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
