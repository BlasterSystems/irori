/**
 * Tiny hash router: "#/node/:id" for the node drill-down, "#/models" for the
 * Models v2 page, "#/serve" for serving orchestration, everything else is the
 * fleet overview. vue-router is deliberately not used (M1 constraint).
 */
export type Route = { view: "overview" } | { view: "node"; id: string } | { view: "models" } | { view: "serve" } | { view: "benchmarks" };

export function parseHash(hash: string): Route {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const m = /^\/node\/([^/]+)$/.exec(h);
  const id = m?.[1];
  if (id !== undefined) {
    try {
      return { view: "node", id: decodeURIComponent(id) };
    } catch {
      // A truncated shared link (e.g. "#/node/abc%2") must not white-screen
      // the app at boot — fall back to the raw segment.
      return { view: "node", id };
    }
  }
  if (h === "/models") return { view: "models" };
  if (h === "/serve") return { view: "serve" };
  if (h === "/benchmarks") return { view: "benchmarks" };
  return { view: "overview" };
}

export function nodeHash(id: string): string {
  return `#/node/${encodeURIComponent(id)}`;
}

export function modelsHash(): string {
  return "#/models";
}

export function serveHash(): string {
  return "#/serve";
}

export function benchmarksHash(): string {
  return "#/benchmarks";
}
