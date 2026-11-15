import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import nodeCardSource from "../src/components/NodeCard.vue?raw";
import llmPanelSource from "../src/components/LlmPanel.vue?raw";
import llmDataSource from "../src/llm-data.ts?raw";
import nodeDetailSource from "../src/components/NodeDetail.vue?raw";
import sparklineSource from "../src/components/Sparkline.vue?raw";
import appSource from "../src/App.vue?raw";

// vitest's css pipeline returns "" for *.css?raw — read the stylesheet directly.
const cssSource = readFileSync(new URL("../src/assets/irori.css", import.meta.url), "utf8");

/**
 * DOM-free DS fidelity guard: the components must use the mockup vocabulary
 * (irori.css classes) verbatim. Rendering tests need jsdom and are deferred.
 */
it("NodeCard keeps the DS card vocabulary", () => {
  for (const cls of ["card", "card__head", "card__body", "chip", "barrow", "bar__fill", "mono faint"]) {
    expect(nodeCardSource).toContain(cls);
  }
  // IR-103: no status chip on healthy cards; offline is a strip + error border.
  expect(nodeCardSource).toContain("card--offline");
  expect(nodeCardSource).toContain("offline-strip");
  expect(nodeCardSource).not.toContain("card.statusText");
  expect(nodeCardSource).toContain("waiting for first snapshot");
});

it("App keeps the DS v1.1 shell: sidebar lockup, nav, topbar chrome", () => {
  // Sidebar: canonical v1.1 lockup + nav items with aria-current.
  for (const cls of ["bs-sidebar", "bs-lockup", "bs-lockup__glyph", "mark-node", "mark-line", "mark-square", "bs-lockup__name", "bs-lockup__endorse", "bs-nav", "bs-nav-item", "aria-current", "bs-sidebar__foot"]) {
    expect(appSource).toContain(cls);
  }
  // IR-234: the endorse line is the short BLASTERSYSTEMS mark — the full
  // "A BlasterSystems product" ran 24px under the collapse chevron.
  expect(appSource).toContain('>BLASTERSYSTEMS</span>');
  expect(appSource).not.toContain('A BlasterSystems product');
  expect(appSource).toContain("irori-theme");
  // IRI-025: no status chip while healthy; the warn OFFLINE chip is the only state.
  expect(appSource).toContain('v-if="!connected"');
  expect(appSource).not.toContain("Connecting…");
  // IRI-025: the hub-settings gear lives in the topbar, beside the theme toggle.
  expect(appSource).toContain('aria-label="Hub settings"');
  // IRI-013: the fleet page body moved to OverviewView — the shell keeps only routing.
  expect(appSource).toContain("<OverviewView v-else />");
  // M8: Usage is a first-class nav entry mounted as its own view.
  expect(appSource).toContain("usageHash()");
  expect(appSource).toContain('<UsageView v-else-if="route.view === \'usage\'" />');
  // IR-214: nav counts are hub-derived totals; the mobile menu carries the
  // deploy line (IR-197 B1 home) and the live status.
  expect(appSource).toContain("bs-nav-item__count");
  expect(appSource).toContain("refreshNavCounts");
  expect(appSource).toContain("bs-menu-foot");
  expect(appSource).toContain('deploy {{ serverTag ?? "unknown" }}');
  expect(appSource).toContain('Irori {{ serverVersion ?? "…" }}');
  // Transfers stay reachable from page chrome with the live count bubble.
  expect(appSource).toContain('aria-label="Open transfers"');
  expect(appSource).toContain("countbub");
  // IR-224 S4: the menu owns the range + Add node (sidebar tools; hamburger
  // ≤900; collapsed-rail popover); the collapsed pick persists; the perf chip
  // renders on every route but the Overview and the NodeModal is shell-level.
  expect(appSource).toContain("bs-sidebar__collapse");
  expect(appSource).toContain("irori.sidebar.collapsed");
  expect(appSource).toContain("bs-sidebar__tools");
  expect(appSource).toContain("rangeseg-pop");
  expect(appSource).toContain('aria-label="History range"');
  expect(appSource).toContain("setOverviewRange");
  expect(appSource).toContain("bs-perf");
  expect(appSource).toContain("route.view !== 'overview'");
  expect(appSource).toContain('<NodeModal v-if="addNodeOpen" mode="create"');
  expect(appSource).toContain("BsIcon");
});

it("UsageView keeps the DS section vocabulary (M8)", () => {
  const src = readFileSync(new URL("../src/components/UsageView.vue", import.meta.url), "utf8");
  for (const cls of ["pagehead", "tabs", "seg", "statgrid", "card__head", "card__body--flush", "table", "chip", "drawer-scrim", "drawer", "btn--ghost"]) {
    expect(src).toContain(cls);
  }
  // Live indicator mirrors the topbar chip; tabs come from the shared USAGE_TABS.
  expect(src).toContain("USAGE_TABS");
  expect(src).toContain("live.connected");
});

it("OverviewView keeps the page vocabulary: pagehead, card grid, first-run ghost", () => {
  const src = readFileSync(new URL("../src/components/OverviewView.vue", import.meta.url), "utf8");
  // IR-224 S4/S6: the range control and the Add node CTA live in the shell
  // menu — the pagehead carries the title and the fleet summary only.
  for (const cls of ["pagehead", "cols-3", "ghost-grid"]) {
    expect(src).toContain(cls);
  }
  expect(src).not.toContain("Add node…");
  expect(src).not.toContain("<NodeModal");
  // IRI-010: the empty state is the mockup's first-run ghost; node management
  // lives in the shell-level NodeModal (reachable from any route).
  expect(src).toContain("no nodes yet");
});

it("App pins the v1.1 shell geometry: sidebar column, sticky paper-2 topbar", () => {
  for (const rule of [
    ".shell { display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); }",
    ".bs-sidebar { position: sticky; top: 0; flex: none; width: var(--sidebar-width); height: 100vh;",
    "background: var(--paper-2); border-right: 1px solid var(--rule);",
    ".bs-topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between;",
    "backdrop-filter: blur(12px); border-bottom: 1px solid var(--rule); }",
    ".content { padding: 28px 32px 48px; min-width: 0; max-width: var(--content-max); }",
  ]) {
    expect(cssSource).toContain(rule);
  }
  // IR-197 B1: the deploy tag's committed home is the mobile menu footer.
  expect(cssSource).toContain(".bs-menu-foot { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; padding: 12px 22px 4px; border-top: 1px solid var(--rule);");
  // IR-224 S4: the collapsed rail narrows the shell via html[data-nav]; the
  // perf chip is the topbar's away-pages inference summary.
  expect(cssSource).toContain('html[data-nav="collapsed"] .shell { grid-template-columns: var(--sidebar-width-collapsed, 68px) minmax(0, 1fr); }');
  // IR-238: the collapsed rail centers on one 34px axis — the brand is a real
  // flex column (glyph + chevron stack), the chevron loses the inert auto
  // margin, the range-popover trigger centers via flex, and the foot status
  // keeps mockup parity.
  expect(cssSource).toContain('html[data-nav="collapsed"] .bs-sidebar__brand { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 0; }');
  expect(cssSource).toContain('html[data-nav="collapsed"] .bs-sidebar__collapse { position: static; margin: 0; transform: rotate(180deg); }');
  expect(cssSource).toContain('html[data-nav="collapsed"] .bs-sidebar__tools .rangeseg-pop { display: flex; justify-content: center; }');
  // IR-249: the Add node button caps to the control square (align-self:center
  // un-stretches the flex-column item) so it pairs with the 36px range trigger.
  expect(cssSource).toContain('html[data-nav="collapsed"] .bs-sidebar__tools .btn { width: var(--control-sm); padding: 0; justify-content: center; align-self: center; }');
  expect(cssSource).toContain('html[data-nav="collapsed"] .bs-sidebar__status { align-items: center; }');
  expect(cssSource).toContain(".bs-perf { display: inline-flex; align-items: center; gap: 9px; min-height: 36px; padding: 0 12px;");
});

it("NodeDetail keeps the DS drill-down vocabulary", () => {
  for (const cls of ["pagehead", "label", "row", "chip", "dot", "card", "card__head", "card__body", "barrow", "bar__fill", "seg", "is-active", "banner--warn", "stat__sub", "mono faint", "cols-2", "muted"]) {
    expect(nodeDetailSource).toContain(cls);
  }
  expect(nodeDetailSource).toContain("aria-label=\"History range\"");
  expect(nodeDetailSource).toContain("HISTORY_RANGES");
  expect(nodeDetailSource).toContain("waiting for first snapshot");
  expect(nodeDetailSource).toContain("no data yet");
  expect(nodeDetailSource).toContain("href=\"#/\"");
});

it("NodeDetail keeps the M3 inference section vocabulary", () => {
  expect(nodeDetailSource).toContain(">Inference</h2>");
  expect(nodeDetailSource).toContain("no LLM ports configured");
  expect(nodeDetailSource).toContain("<LlmPanel");
  expect(nodeDetailSource).toContain("inference history unavailable");
});

it("NodeDetail gates the store catalog to the store node and renders cpu clock notes (IRI-034)", () => {
  expect(nodeDetailSource).toContain(`inventory.store && node?.kind === 'nas'`);
  expect(nodeDetailSource).toContain(`v-for="note in detail.cpu.notes"`);
  expect(nodeDetailSource).toContain("store catalog renders on the store node");
});

it("LlmPanel keeps the DS per-port panel vocabulary", () => {
  for (const cls of ["card", "card__head", "card__body", "row", "chip", "barrow", "bar__fill", "kv", "stat__sub", "muted", "mono faint"]) {
    expect(llmPanelSource).toContain(cls);
  }
  // Detected/idle chips are driven by the view model; the classes live in llm-data.
  expect(llmPanelSource).toContain(':class="port.backendChipClass"');
  for (const cls of ['"chip--ok"', '"chip--muted"']) {
    expect(llmDataSource).toContain(cls);
  }
  for (const text of ["no engine answered", "detection-only (worker)", "Probes continue on idle ports", "Decode", "Prefill", "Queue", "KV cache", "TTFT p95"]) {
    expect(llmPanelSource).toContain(text);
  }
  expect(llmPanelSource).toContain("<Sparkline");
});

it("Sparkline renders the DS .spark svg with token stroke colors", () => {
  for (const token of ["spark", "preserveAspectRatio=\"none\"", "stroke-width=\"1.5\"", "var(--ink-2)"]) {
    expect(sparklineSource).toContain(token);
  }
  expect(sparklineSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // no hard-coded hex
});
