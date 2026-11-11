// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HealthFinding } from "@irori/core";
import InfraBanner from "../src/components/InfraBanner.vue";
import OverviewView from "../src/components/OverviewView.vue";

// readFileSync, not ?raw: the css pipeline serves ?raw imports as '' in vitest.
const bannerSource = readFileSync(resolve(process.cwd(), "src/components/InfraBanner.vue"), "utf8");

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

describe("InfraBanner (IR-203)", () => {
  it("renders nothing without findings", () => {
    const w = mount(InfraBanner as never, { props: { findings: [] } } as never);
    expect(w.find(".infra-banner").exists()).toBe(false);
    w.unmount();
  });

  it("hides per-node findings; only fleet-scoped rows render", () => {
    const w = mount(InfraBanner as never, {
      props: {
        findings: [
          finding(),
          finding({
            nodeId: "00000000-0000-4000-8000-000000000002",
            ruleId: "22222222-2222-4222-8222-222222222222",
            metric: "disk_pct",
            severity: "warn",
            summary: "Disk usage warn: 91 >= 80",
          }),
        ],
      },
    } as never);
    const rows = w.findAll(".infra-banner__row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain("Database unavailable");
    expect(rows[0]!.text()).toContain("stale until the database returns");
    expect(rows[0]!.classes()).toContain("banner--critical");
    expect(rows[0]!.attributes("role")).toBe("alert");
    w.unmount();
  });

  it("renders hub-disk rows with the runbook hint and warn severity", () => {
    const w = mount(InfraBanner as never, {
      props: {
        findings: [finding({ metric: "hub_disk_pct", severity: "warn", ruleId: "33333333-3333-4333-8333-333333333333", summary: "Hub disk warn: 81 >= 80" })],
      },
    } as never);
    const row = w.find(".infra-banner__row");
    expect(row.text()).toContain("Hub disk pressure");
    expect(row.text()).toContain("docker system df");
    expect(row.classes()).not.toContain("banner--critical");
    expect(row.text()).toContain("◇");
    w.unmount();
  });

  it("renders unknown fleet metrics summary-only and never blocks wide", () => {
    const w = mount(InfraBanner as never, {
      props: { findings: [finding({ metric: "kernel_xid" as never, summary: "Xid: 3 > 0" })] },
    } as never);
    const row = w.find(".infra-banner__row");
    expect(row.text()).toContain("Xid");
    expect(row.text()).not.toContain("docker");
    w.unmount();
    // IR-196 structural pin: the body shrinks instead of pushing the page wide.
    expect(bannerSource).toContain("min-width: 0");
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
    const banner = w.find(".infra-banner");
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
    expect(w.find(".infra-banner").exists()).toBe(false);
    w.unmount();
  });
});
