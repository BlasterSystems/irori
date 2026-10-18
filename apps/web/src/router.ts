/**
 * Tiny hash router: "#/node/:id" for the node drill-down, "#/models" for the
 * Models v2 page, everything else is the fleet overview. vue-router is
 * deliberately not used (M1 constraint).
 */
export type Route = { view: "overview" } | { view: "node"; id: string } | { view: "models" };

export function parseHash(hash: string): Route {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const m = /^\/node\/([^/]+)$/.exec(h);
  const id = m?.[1];
  if (id !== undefined) {
    return { view: "node", id: decodeURIComponent(id) };
  }
  if (h === "/models") return { view: "models" };
  return { view: "overview" };
}

export function nodeHash(id: string): string {
  return `#/node/${encodeURIComponent(id)}`;
}

export function modelsHash(): string {
  return "#/models";
}
