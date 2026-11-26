/**
 * IRI-156: hub URLs shown in the Add-node install block, derived from the
 * page's own location so the copied command works for whatever scheme the
 * browser reached the hub through. Behind a TLS reverse proxy the page is
 * https:, and plain ws:// gets the proxy's 301 to https — which WebSocket
 * clients do not follow — so the agent must dial wss:// instead.
 */
export interface PageLocation {
  protocol: string;
  host: string;
}

/** The WS URL the agent dials: wss:// on https pages, ws:// otherwise. */
export function agentWsUrl(loc: PageLocation | undefined): string {
  if (loc === undefined) return "ws://<server>:3947/agent-ws";
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/agent-ws`;
}

/** The hub's own HTTP root; the script, unit and bundle are served here. */
export function hubHttpBase(loc: PageLocation | undefined): string {
  return loc === undefined ? "http://<server>:3947" : `${loc.protocol}//${loc.host}`;
}
