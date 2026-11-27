import type { Express, Response } from "express";
import type { AuditService } from "./audit.js";
import { audit } from "./audit-routes.js";
import type { NetworkService } from "./network-service.js";
import { networkSettingsPatchSchema, type NetworkSettingsService } from "./network-settings.js";

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
