import type { Express, Response } from "express";
import type { NetworkService } from "./network-service.js";

/**
 * IRI-162+ (ADR-0021): the network routes. Degraded hubs (no DB) answer 503
 * like every other store-backed route; the topology itself needs no DB but
 * reads the node registry.
 */
export interface NetworkRouteDeps {
  getNetwork: () => NetworkService | null;
}

export function registerNetworkRoutes(app: Express, deps: NetworkRouteDeps): void {
  const requireNetwork = (res: Response): NetworkService | null => {
    const svc = deps.getNetwork();
    if (svc === null) res.status(503).json({ error: "network service unavailable" });
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
}
