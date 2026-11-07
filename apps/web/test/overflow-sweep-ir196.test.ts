// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import analyticsSource from "../src/components/AnalyticsView.vue?raw";
import nodeDetailSource from "../src/components/NodeDetail.vue?raw";
import usageViewSource from "../src/components/UsageView.vue?raw";

// readFileSync, not ?raw: the css pipeline serves ?raw imports as '' in vitest;
// process.cwd() (not import.meta.url): happy-dom does not give a file: URL.
const cssSource = readFileSync(resolve(process.cwd(), "src/assets/irori.css"), "utf8");

/**
 * IR-196: horizontal overflow sweep pins. The acceptance bar is the live
 * sweep (vite + forwarder, 11 routes x 320/390/480/720 x light/dark with
 * documentElement.scrollWidth <= innerWidth); these structural pins keep the
 * fixes from regressing (IRI-124 lesson: structural pins over pixel geometry).
 *
 * Measured culprits this file pins shut:
 * - .tip::after tooltips laid out at rest (opacity:0) pushed documents to
 *   588-610px whenever a tip sat right of the viewport edge;
 * - .visually-hidden labels at their static position escaped clipped wide
 *   tables to the ICB (benchmarks compare labels);
 * - unbreakable model/repo tokens set table column min-content (node
 *   cache/models cards);
 * - statgrid items with min-width:auto let nowrap values push the item box;
 * - AnalyticsView's three .tbl tables had no CSS and no wrapper;
 * - NodeDetail path / UsageView signature ellipsis caps exceeded the column.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("IR-196 overflow sweep — structural pins", () => {
  it("statgrid items shrink and ellipsize nowrap values", () => {
    expect(cssSource).toContain(".statgrid .stat { min-width: 0; }");
    const guard = cssSource.match(/\.statgrid \.stat__value \{[^}]+\}/);
    expect(guard).not.toBeNull();
    expect(guard![0]).toContain("min-width: 0");
    expect(guard![0]).toContain("text-overflow: ellipsis");
  });

  it("table cells wrap unbreakable tokens instead of pushing the page wide", () => {
    const td = cssSource.match(/\.table td \{[^}]+\}/);
    expect(td).not.toBeNull();
    expect(td![0]).toContain("overflow-wrap: anywhere");
  });

  it("visually-hidden labels park at the containing-block origin (no ICB escape)", () => {
    const vh = cssSource.match(/\.visually-hidden \{[^}]+\}/);
    expect(vh).not.toBeNull();
    expect(vh![0]).toContain("top: 0");
    expect(vh![0]).toContain("left: 0");
  });

  it("tooltips generate no box at rest (display:none, not opacity:0)", () => {
    const after = cssSource.match(/\.tip::after \{[^}]+\}/);
    expect(after).not.toBeNull();
    expect(after![0]).toContain("display: none");
    expect(cssSource).toContain(".tip:hover::after { display: block; }");
  });

  it("the <=720 .stage rule is a real grid (was inert without display)", () => {
    expect(cssSource).toContain(
      "body .stage { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; }",
    );
  });

  it("AnalyticsView tables use the flush-wrapper idiom (no undefined .tbl)", () => {
    expect(analyticsSource).not.toMatch(/class="tbl"/);
    expect((analyticsSource.match(/class="card__body card__body--flush"/g) ?? []).length).toBe(3);
    expect((analyticsSource.match(/<table class="table">/g) ?? []).length).toBe(3);
  });

  it("inline ellipsis caps collapse to the column (NodeDetail paths, UsageView signatures)", () => {
    expect(nodeDetailSource).toContain("max-width: min(320px, 100%)");
    expect(usageViewSource).toContain("max-width: min(420px, 100%)");
    // .model-repo: nowrap cell min-content is the full text — wraps <=720 instead.
    expect(nodeDetailSource).toContain("@media (max-width: 720px) {\n  .model-repo { max-width: none; white-space: normal; overflow-wrap: anywhere; }\n}");
    // the cache model table gets the same internal-scroll wrapper as the store one
    expect(nodeDetailSource).toContain('<div v-else class="model-scroll">');
  });
});

describe("IR-196: AnalyticsView mounts (zero-coverage ratchet)", () => {
  it("mounts the analytics view end to end", async () => {
    window.location.hash = "#/analytics";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        let body: unknown = {};
        if (url.includes("/analytics/efficiency")) body = { nodes: [], models: [] };
        else if (url.includes("/analytics/token-reconciliation")) body = { rows: [] };
        else if (url.includes("/api/v1/analytics/")) {
          const u = new URL(url, "http://localhost");
          body = {
            lens: u.pathname.split("/").pop(),
            range: u.searchParams.get("range"),
            groupBy: u.searchParams.get("groupBy"),
            series: [],
            granularity: "hour",
          };
        } else if (url.includes("/api/v1/nodes")) body = [];
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    // Dynamic import per house harness (view-batch/big-views): the stub and
    // hash must be in place before the view module's setup reads them.
    const { default: AnalyticsView } = await import("../src/components/AnalyticsView.vue");
    const w = mount(AnalyticsView as never);
    // load() is fire-and-forget (no exposed promise); the house settle sleep
    // lets its fetches resolve in happy-dom. Deterministic await isn't
    // available, and Promise.withResolvers needs an es2024 lib the web
    // tsconfig does not target.
    await new Promise((r) => setTimeout(r, 80));
    expect(w.exists()).toBe(true);
    w.unmount();
  });
});
