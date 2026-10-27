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

it("App keeps the DS topbar lockup and nav", () => {
  for (const cls of ["topbar__in", "brand-mark", "mark-node", "mark-line", "mark-square", "brand-name", "brand-endorsement", "nav", "is-active", "chip--warn", "dot--warn"]) {
    expect(appSource).toContain(cls);
  }
  expect(appSource).toContain("irori-theme");
  // IRI-025: no status chip while healthy; the warn OFFLINE chip is the only state.
  expect(appSource).toContain('v-if="!connected"');
  expect(appSource).not.toContain("Connecting…");
  // IRI-025: the hub-settings gear lives in the topbar, right of the theme toggle.
  expect(appSource).toContain('aria-label="Hub settings"');
  // IRI-013: the fleet page body moved to OverviewView — the shell keeps only routing.
  expect(appSource).toContain("<OverviewView v-else />");
  // M8: Usage is a first-class nav entry mounted as its own view.
  expect(appSource).toContain("usageHash()");
  expect(appSource).toContain('<UsageView v-else-if="route.view === \'usage\'" />');
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

it("OverviewView keeps the page vocabulary: pagehead, card grid, first-run ghost, add node", () => {
  const src = readFileSync(new URL("../src/components/OverviewView.vue", import.meta.url), "utf8");
  for (const cls of ["pagehead", "cols-3", "ghost-grid", "btn--primary"]) {
    expect(src).toContain(cls);
  }
  // IRI-010: the empty state is the mockup's first-run ghost; node management
  // moved into the NodeModal instead of a pointer at the API.
  expect(src).toContain("no nodes yet");
  expect(src).toContain("<NodeModal");
});

it("App pins the version/build footer to the viewport-bottom shell", () => {
  expect(appSource).toContain('<footer class="foot">');
  expect(appSource).toContain('class="container foot__in"');
  for (const rule of [
    "#app { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }",
    ".foot { position: sticky; bottom: 0; z-index: 5;",
    ".foot__in { display: flex; align-items: center; min-height: 38px; }",
  ]) {
    expect(cssSource).toContain(rule);
  }
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
