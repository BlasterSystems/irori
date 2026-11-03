import { afterEach, describe, expect, it } from "vitest";
import { parseHash } from "../src/router";
import { setThresholds, thresholds } from "../src/thresholds";
import { tierFromWidth } from "../src/tiers";

/**
 * IRI-084: unit tier for web pure-logic modules — the hash router (all route
 * shapes), the server-driven threshold overwrite, and the width-tier bands.
 */

describe("parseHash", () => {
  it("routes every documented view", () => {
    expect(parseHash("#/")).toEqual({ view: "overview" });
    expect(parseHash("")).toEqual({ view: "overview" });
    expect(parseHash("#/models")).toEqual({ view: "models" });
    expect(parseHash("#/serve")).toEqual({ view: "serve" });
    expect(parseHash("#/benchmarks")).toEqual({ view: "benchmarks" });
    expect(parseHash("#/analytics")).toEqual({ view: "analytics" });
    expect(parseHash("#/usage")).toEqual({ view: "usage" });
    expect(parseHash("#/chats")).toEqual({ view: "chats" });
    expect(parseHash("#/audit")).toEqual({ view: "audit" });
    expect(parseHash("#/logs")).toEqual({ view: "logs" });
    expect(parseHash("#/community")).toEqual({ view: "community" });
  });

  it("parses node ids including encoded slashes", () => {
    expect(parseHash("#/node/abc")).toEqual({ view: "node", id: "abc" });
    expect(parseHash("#/node/a%2Fb")).toEqual({ view: "node", id: "a/b" });
    expect(parseHash("#/node/a%2")).toEqual({ view: "node", id: "a%2" });
  });

  it("carries recipeJob into serve and query views", () => {
    expect(parseHash("#/serve?recipeJob=abc")).toEqual({ view: "serve", recipeJob: "abc" });
    expect(parseHash("#/serve")).toEqual({ view: "serve" });
    expect(parseHash("#/usage?x=1")).toEqual({ view: "usage" });
  });
});

describe("thresholds", () => {
  afterEach(() => {
    // Restore the seed values for other suites (module state is shared).
    setThresholds({ tempWarnC: 85, tempCriticalC: 92, diskWarnPct: 90 });
  });

  it("starts at the core seed values", () => {
    expect(thresholds.tempWarnC).toBeGreaterThan(0);
    expect(thresholds.diskWarnPct).toBeGreaterThan(0);
  });

  it("overwrites in place (server is the single source of truth)", () => {
    setThresholds({ tempWarnC: 70, tempCriticalC: 80, diskWarnPct: 85 });
    expect(thresholds.tempWarnC).toBe(70);
    expect(thresholds.tempCriticalC).toBe(80);
    expect(thresholds.diskWarnPct).toBe(85);
  });
});

describe("tierFromWidth", () => {
  it("bands small/medium/full", () => {
    expect(tierFromWidth(400)).toBe("small");
    expect(tierFromWidth(700)).toBe("small");
    expect(tierFromWidth(1000)).toBe("medium");
    expect(tierFromWidth(1600)).toBe("full");
  });
});
