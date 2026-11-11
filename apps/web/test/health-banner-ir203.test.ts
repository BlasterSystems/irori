// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HealthFinding } from "@irori/core";
import HealthBanner from "../src/components/HealthBanner.vue";
import OverviewView from "../src/components/OverviewView.vue";

// readFileSync, not ?raw: the css pipeline serves ?raw imports as '' in vitest.
const bannerSource = readFileSync(resolve(process.cwd(), "src/components/HealthBanner.vue"), "utf8");

function finding(overrides: Partial<HealthFinding> = {}): HealthFinding {
  return {
    nodeId: "",
    ruleId: "11111111-1111-4111-8111-111111111111",
    metric: "db_unavailable",
    severity: "critical",
    summary: "Database unavailable: 1 eq 1",
    since: "2026-11-11T09:00:00.000Z",
    ...overrides,
  };
}

describe("HealthBanner (IR-203)", () => {
  it("renders nothing without findings", () => {
    const w = mount(HealthBanner as never, { props: { findings: [], nodes: [] } } as never);
    expect(w.find(".health-banner").exists()).toBe(false);
    w.unmount();
  });

  it("hides per-node findings; only fleet-scoped rows render", () => {
    const w = mount(HealthBanner as never, {
      props: {
        findings: [
          finding(),
          finding({
            nodeId: "00000000-0000-4000-8000-000000000002",
            ruleId: "22222222-2222-4222-8222-222222222222",
            metric: "kernel_xid",
            severity: "warn",
            summary: "Kernel Xid: 3 > 0",
          }),
        ],
        nodes: [],
      },
    } as never);
    const rows = w.findAll(".health-banner__row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain("Database unavailable");
    expect(rows[0]!.text()).toContain("stale until the database returns");
    expect(rows[0]!.classes()).toContain("banner--critical");
    expect(rows[0]!.attributes("role")).toBe("alert");
    w.unmount();
  });

  it("renders hub-disk rows with the runbook hint and warn severity", () => {
    const w = mount(HealthBanner as never, {
      props: {
        findings: [finding({ metric: "hub_disk_pct", severity: "warn", ruleId: "33333333-3333-4333-8333-333333333333", summary: "Hub disk warn: 81 >= 80" })],
        nodes: [],
      },
    } as never);
    const row = w.find(".health-banner__row");
    expect(row.text()).toContain("Hub disk pressure");
    expect(row.text()).toContain("docker system df");
    expect(row.classes()).not.toContain("banner--critical");
    expect(row.text()).toContain("◇");
    w.unmount();
  });

  it("renders unknown fleet metrics summary-only and never blocks wide", () => {
    const w = mount(HealthBanner as never, {
      props: { findings: [finding({ metric: "kernel_xid" as never, summary: "Xid: 3 > 0" })], nodes: [] },
    } as never);
    const row = w.find(".health-banner__row");
    expect(row.text()).toContain("Xid");
    expect(row.text()).not.toContain("docker");
    w.unmount();
    // IR-196 structural pin: the body shrinks instead of pushing the page wide.
    expect(bannerSource).toContain("min-width: 0");
  });
});

describe("HealthBanner node-disk rows (IR-204)", () => {
  const NODE_ID = "00000000-0000-4000-8000-000000000002";
  const NODES = [{ id: NODE_ID, name: "DGX-3" }] as never;

  function cleanupBody(reclaimable: number): string {
    return JSON.stringify({
      latestAudit: {
        report: {
          generatedAtMs: 1,
          totalBytes: null,
          freeBytes: null,
          categories: [{ category: "apt", reclaimableBytes: reclaimable, itemCount: 3 }],
        },
      },
      history: [],
      prevention: { weeklySafePass: false, logRotationApplied: false },
    });
  }

  it("deep-links a disk finding to the node page and shows the est. reclaim", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cleanup")) return new Response(cleanupBody(5 * 1024 ** 3), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchStub);
    const w = mount(HealthBanner as never, {
      props: {
        findings: [finding({ nodeId: NODE_ID, metric: "disk_pct", severity: "warn", ruleId: "44444444-4444-4444-8444-444444444444", summary: "Disk usage warn: 91 >= 80" })],
        nodes: NODES,
      },
    } as never);
    await new Promise((r) => setTimeout(r, 40));
    const row = w.find(".health-banner__row");
    expect(row.text()).toContain("Node disk pressure");
    expect(row.text()).toContain("DGX-3");
    const link = row.find("a");
    expect(link.attributes("href")).toBe(`#/node/${NODE_ID}`);
    const cta = row.find("button");
    expect(cta.text()).toContain("est. +5.4 GB");
    // The est. fetch is a GET; the banner itself never POSTs.
    expect(fetchStub.mock.calls.every(([i]) => !(i instanceof Request) || i.method !== "POST")).toBe(true);
    w.unmount();
  });

  it("hides the est. text when the audit is empty or the fetch fails", async () => {
    const fetchStub = vi.fn(async () => new Response(cleanupBody(0), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchStub);
    const w = mount(HealthBanner as never, {
      props: {
        findings: [finding({ nodeId: NODE_ID, metric: "disk_pct", severity: "warn", ruleId: "44444444-4444-4444-8444-444444444444", summary: "Disk usage warn: 91 >= 80" })],
        nodes: NODES,
      },
    } as never);
    await new Promise((r) => setTimeout(r, 40));
    expect(w.find(".health-banner__cta").text()).toBe("Clean up disk");
    w.unmount();

    const failStub = vi.fn(async () => new Response("no", { status: 503 }));
    vi.stubGlobal("fetch", failStub);
    const w2 = mount(HealthBanner as never, {
      props: {
        findings: [finding({ nodeId: NODE_ID, metric: "disk_pct", severity: "warn", ruleId: "55555555-5555-4555-8555-555555555555", summary: "Disk usage warn: 92 >= 80" })],
        nodes: NODES,
      },
    } as never);
    await new Promise((r) => setTimeout(r, 40));
    expect(w2.find(".health-banner__cta").text()).toBe("Clean up disk");
    w2.unmount();
  });

  it("opens the cleanup drawer on click and no job POST leaves the banner", async () => {
    const methods: string[] = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      methods.push(init?.method ?? (input instanceof Request ? input.method : "GET"));
      if (url.includes("/cleanup")) return new Response(cleanupBody(2 * 1024 ** 3), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchStub);
    const w = mount(HealthBanner as never, {
      props: {
        findings: [finding({ nodeId: NODE_ID, metric: "disk_pct", severity: "warn", ruleId: "44444444-4444-4444-8444-444444444444", summary: "Disk usage warn: 91 >= 80" })],
        nodes: NODES,
      },
    } as never);
    await new Promise((r) => setTimeout(r, 40));
    await w.find(".health-banner__cta").trigger("click");
    await new Promise((r) => setTimeout(r, 60));
    expect(w.find(".drawer-scrim").exists()).toBe(true); // the drawer opened
    expect(methods.every((m) => m !== "POST")).toBe(true); // read-only banner
    w.unmount();
  });

  it("banner hint text matches the Signal runbook (IR-205)", () => {
    // readFileSync, not ?raw: the css pipeline serves ?raw imports as '' in
    // vitest; cwd is apps/web, the repo docs live two levels up.
    const runbook = readFileSync(resolve(process.cwd(), "../../docs/DEPLOYMENT.md"), "utf8");
    expect(runbook).toContain("hub data on the page may be stale until the database returns");
    expect(runbook).toContain("Degraded routes keep answering");
    expect(runbook).toContain("Check the hub VM filesystem — docker build cache is the usual culprit");
    expect(runbook).toContain("docker system df");
    expect(runbook).toContain("on the deploy host");
  });
});

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("OverviewView mounts with the banner (IR-203)", () => {
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
    else if (url.includes("/api/v1/analytics")) body = { range: "30m", granularity: "minute", series: [] };
    else if (["/setups", "/nodes", "/jobs", "/quants", "/health/findings", "/api/v1/bench"].some((e) => url.includes(e))) body = [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });

  it("shows the banner above the page content when a fleet finding is open", async () => {
    vi.stubGlobal("fetch", fetchStub);
    const { liveMock } = await import("./live-mock");
    (liveMock.findings as { value: unknown[] }).value = [finding() as never];
    const { default: Overview } = await import("../src/components/OverviewView.vue");
    const w = mount(Overview as never);
    await new Promise((r) => setTimeout(r, 120));
    const banner = w.find(".health-banner");
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("Database unavailable");
    w.unmount();
    (liveMock.findings as { value: unknown[] }).value = [];
  });

  it("mounts clean with no findings (banner absent, zero errors)", async () => {
    vi.stubGlobal("fetch", fetchStub);
    const { liveMock } = await import("./live-mock");
    (liveMock.findings as { value: unknown[] }).value = [];
    const { default: Overview } = await import("../src/components/OverviewView.vue");
    const w = mount(Overview as never);
    await new Promise((r) => setTimeout(r, 120));
    expect(w.find(".health-banner").exists()).toBe(false);
    w.unmount();
  });
});
