import { describe, expect, it } from "vitest";
import { levelFromLine, levelsAtLeast } from "@irori/core";
import {
  DEFAULT_LOG_FILTERS,
  levelChipClass,
  logsHashFor,
  logsNodeHash,
  logsSetupHash,
  parseLogsHash,
  rowSummary,
  serverLogFilters,
} from "../src/logs-data";
import { fetchLogs } from "../src/api";
import { parseHash } from "../src/router";
import appSource from "../src/App.vue?raw";
import serveViewSource from "../src/components/ServeView.vue?raw";
import auditViewSource from "../src/components/AuditView.vue?raw";

describe("parseLogsHash", () => {
  it("defaults on a bare or junk hash", () => {
    expect(parseLogsHash("#/logs")).toEqual(DEFAULT_LOG_FILTERS);
    expect(parseLogsHash("junk")).toEqual(DEFAULT_LOG_FILTERS);
  });

  it("reads every filter from the query string", () => {
    expect(
      parseLogsHash("#/logs?range=24h&node=n-1&setup=s-1&run=r-1&job=j-1&scope=setup&source=engine&level=warn&q=oom"),
    ).toEqual({
      range: "24h",
      nodeId: "n-1",
      setupId: "s-1",
      runId: "r-1",
      jobId: "j-1",
      scope: "setup",
      source: "engine",
      level: "warn",
      q: "oom",
    });
  });

  it("falls back per-field on junk values, never throws", () => {
    expect(parseLogsHash("#/logs?range=nope&scope=bogus&level=bogus&source=bogus")).toEqual(DEFAULT_LOG_FILTERS);
  });

  it("caps oversized q at the server bound", () => {
    const parsed = parseLogsHash(`#/logs?q=${"x".repeat(200)}`);
    expect(parsed.q.length).toBe(128);
  });
});

describe("logsHashFor round-trip", () => {
  it("writes and reads back non-default filters", () => {
    const h = logsHashFor({ range: "6h", scope: "setup", level: "warn", q: "boom", setupId: "s-1", runId: "r-9" });
    expect(parseLogsHash(h)).toEqual({ ...DEFAULT_LOG_FILTERS, range: "6h", scope: "setup", level: "warn", q: "boom", setupId: "s-1", runId: "r-9" });
  });

  it("omits the all tabs and empty filters", () => {
    expect(logsHashFor({ scope: "all", level: "all", source: "all" })).toBe("#/logs");
    expect(logsHashFor({ range: "1h" })).toBe("#/logs?range=1h");
  });

  it("the setup deep link (Serve's Logs button) parses back to setup+run", () => {
    const parsed = parseLogsHash(logsSetupHash("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"));
    expect(parsed.setupId).toBe("00000000-0000-4000-8000-000000000001");
    expect(parsed.runId).toBe("00000000-0000-4000-8000-000000000002");
    // A null run (stopped setup) still pre-filters by setup only.
    expect(parseLogsHash(logsSetupHash("00000000-0000-4000-8000-000000000001")).runId).toBe("");
    expect(parseLogsHash(logsNodeHash("n-1")).nodeId).toBe("n-1");
  });

  it("the router routes #/logs to the logs view", () => {
    expect(parseHash("#/logs")).toEqual({ view: "logs" });
    expect(parseHash("#/logs?level=warn")).toEqual({ view: "logs" });
  });

  it("server filters drop all-tabs and trim q", () => {
    expect(serverLogFilters({ ...DEFAULT_LOG_FILTERS, q: "  oom  " })).toEqual({ q: "oom" });
    expect(serverLogFilters({ ...DEFAULT_LOG_FILTERS, scope: "job", level: "warn", nodeId: "n" })).toEqual({
      scope: "job",
      level: "warn",
      nodeId: "n",
    });
  });
});

describe("level presentation", () => {
  it("error/warn chips pop, others are plain", () => {
    expect(levelChipClass("error")).toContain("chip--error");
    expect(levelChipClass("warn")).toContain("chip--warn");
    expect(levelChipClass("info")).toBe("chip");
  });

  it("levelsAtLeast is the inclusive severity slice", () => {
    expect(levelsAtLeast("warn")).toEqual(["warn", "error"]);
    expect(levelsAtLeast("trace")).toEqual(["trace", "debug", "info", "warn", "error"]);
    expect(levelFromLine("CUDA out of memory")).toBe("error");
    expect(levelFromLine("weights loaded")).toBe("info");
  });

  it("row summary carries scope/source and the line", () => {
    const summary = rowSummary({
      id: "1",
      eventId: "00000000-0000-4000-8000-000000000001",
      nodeId: "n",
      ts: "2026-11-03T10:00:00.000Z",
      eventTs: 0,
      scope: "setup",
      setupId: null,
      runId: "r-1",
      jobId: null,
      level: "error",
      source: "driver",
      seq: 7,
      line: "driver: start failed: boom",
    });
    expect(summary).toContain("setup/driver #7");
    expect(summary).toContain("driver: start failed: boom");
  });
});

describe("source guards (wiring, not behavior)", () => {
  it("App.vue routes the logs view and Serve links the durable logs", () => {
    expect(appSource).toContain("LogsView");
    expect(serveViewSource).toContain("logsSetupHash");
    expect(serveViewSource).toContain("openDurableLogs");
    expect(auditViewSource).toContain("logsSetupHash");
  });

  it("api client hits the documented endpoints", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ rows: [], nextCursor: null, latestId: null, truncated: false }), { status: 200 });
    }) as typeof fetch;
    try {
      await fetchLogs({ range: "1h" });
    } finally {
      globalThis.fetch = original;
    }
    expect(calls[0]).toContain("/api/v1/logs?");
    expect(calls[0]).toContain("range=1h");
  });
});
