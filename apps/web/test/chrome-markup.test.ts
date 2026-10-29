import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import nodeCardSource from "../src/components/NodeCard.vue?raw";
import nodeDetailSource from "../src/components/NodeDetail.vue?raw";
import cleanupDrawerSource from "../src/components/CleanupDrawer.vue?raw";
import lensChartSource from "../src/components/LensChart.vue?raw";
import sparklineSource from "../src/components/Sparkline.vue?raw";
import analyticsViewSource from "../src/components/AnalyticsView.vue?raw";
import modelsViewSource from "../src/components/ModelsView.vue?raw";
import llmPanelSource from "../src/components/LlmPanel.vue?raw";

// vitest's css pipeline returns "" for *.css?raw — read the stylesheet directly.
const cssSource = readFileSync(new URL("../src/assets/irori.css", import.meta.url), "utf8");

/**
 * DOM-free chrome guards for the card/hygiene UI (complements ds-markup.test.ts):
 * the template wiring and the shared drawer CSS have no render-test layer, so
 * the load-bearing tokens are pinned here against the actual sources.
 */
it("NodeCard and NodeDetail render the importance-ordered rows with the hot-value accent", () => {
  for (const src of [nodeCardSource, nodeDetailSource]) {
    for (const token of [
      'v-for="row in card.rows"',
      ':key="row.key"',
      "isHotTemp(row.tempC)",
      "formatTemp(row.tempC)",
      "'metric--hot': isHotTemp(row.tempC)",
      "'metric--hot': row.warn === true",
      "bar__fill bar__fill--free", // IR-98: available space trails the used fill in the warn hue
    ]) {
      expect(src).toContain(token);
    }
  }
  // IR-98: the usage-percent chip is gone from the card — free space lives in the bar.
  expect(nodeCardSource).not.toContain("Disk {{");
});

it("CleanupDrawer keeps the shared drawer chrome, the DS table class and the reclaimable total", () => {
  for (const token of [
    'class="drawer is-open"', // mobile body .drawer { visibility: hidden } contract
    'class="table"', // DS table vocabulary (replaces the unstyled .tbl)
    "{{ fmtBytes(totalReclaimable) }} reclaimable",
    "care rows are opt-in",
    "never audited — run an audit to estimate reclaimable space",
  ]) {
    expect(cleanupDrawerSource).toContain(token);
  }
  expect(cleanupDrawerSource).not.toContain('class="tbl"');
});

it("NodeDetail describes what the hygiene CTA does", () => {
  expect(nodeDetailSource).toContain("dry-run plan first, nothing deleted without a typed confirm");
});

it("CleanupDrawer scopes staging cleanup to the store node (IRI-046)", () => {
  // Server strips modelctl-staging from non-store audits; the row that survives
  // is store-volume data — labeled and explained as such, never node disk.
  expect(cleanupDrawerSource).toContain(`row.category === 'modelctl-staging'"`);
  expect(cleanupDrawerSource).toContain(">NAS store</span>");
  expect(cleanupDrawerSource).toContain("frees space on the store volume — not this node's disk");
});

it("NodeDetail puts the Sensors card and the inference panels side by side (IRI-037)", () => {
  // One shared cols-2 row carries both cells (was: two half-width rows).
  const sections = nodeDetailSource.match(/<section class="cols cols-2"/g) ?? [];
  expect(sections.length).toBe(1); // History's grid has a v-if before the class
  expect(nodeDetailSource).toContain('class="inference-cell"');
  expect(nodeDetailSource).toContain(".inference-cell > .card + .card");
});

it("NodeDetail uses the IRI-043 overlay idiom — one scrim, inline sheet confirm (IRI-044)", () => {
  // The two hand-rolled stacked confirm scrims are gone: exactly ONE
  // confirm-card block remains, for host-less page actions.
  expect((nodeDetailSource.match(/class="card confirm-card"/g) ?? []).length).toBe(1);
  expect(nodeDetailSource).not.toContain("deleteTarget");
  expect(nodeDetailSource).not.toContain("registerTarget");
  expect(nodeDetailSource).not.toContain("model-log");
  for (const token of [
    'class="card drawer is-open"', // mobile body .drawer { visibility: hidden } contract
    'v-scrim-close="closeTopMost"', // backdrop closes the top layer first
    "confirmState.host === 'job'", // the cancel confirm renders INSIDE the sheet
    'class="inline-confirm"',
    'class="joblog mono"',
    'class="row row--between sheet__foot"',
    "Model operation",
    "Show output",
    "nothing destructive runs until you confirm",
  ]) {
    expect(nodeDetailSource).toContain(token);
  }
  // Cancel is guarded like every other surface — never instant.
  expect(nodeDetailSource).toContain("@click=\"confirmSheetCancel\"");
});

it("irori.css ships the shared drawer chrome and the hot-value accent", () => {
  for (const rule of [
    ".drawer-scrim { position: fixed; inset: 0; background: var(--overlay);",
    ".drawer { width: min(560px, 100%); max-height: 88vh; overflow: auto; padding: 14px;",
    ".metric--hot { color: var(--thread-ink); }",
  ]) {
    expect(cssSource).toContain(rule);
  }
});

it("ModelsView always queues downloads and shows the queue panel (IRI-014/015/016)", () => {
  for (const token of [
    "enqueueDownload({", // single-row path still goes through POST /downloads
    "enqueueDownloadsBatch({", // bulk path: ONE atomic submission
    "Download queue",
    "downloadStatusChip(e.status)",
    "retryEntry(e.id)",
    "removeEntry(e.id)",
    "`Add ${downloadRows.length} to queue`",
    '"Add to queue"', // IRI-016: no "Add 0 to queue" at zero rows
    "parsePaste()", // paste → editable rows
    "pickStoreNode(nodes.value)", // NAS-preferred store node (shared core policy)
    "clearInterval(queuePoll)",
    // IRI-016: per-row quantization/mtp + expand-quants against the hub listing.
    "fetchHfQuants(",
    "openExpand(row)",
    "expandAddable",
    "dl-drawer", // modal spacing fix (brief §7)
  ]) {
    expect(modelsViewSource).toContain(token);
  }
  // The dead unstyled table class is gone; DS .table everywhere.
  expect(modelsViewSource).not.toContain("hytable");
  // The legacy immediate-start path must be gone.
  expect(modelsViewSource).not.toContain('createJob(nodeId, "download-queue"');
});

it("charts show a hover tooltip; call sites pass unit formatters", () => {
  for (const src of [lensChartSource, sparklineSource]) {
    for (const token of [
      'class="charttip"', // shared fixed-position tooltip (irori.css, z 6)
      "@pointermove=", // value appears on hover, not only on tap
      "@pointerleave=",
    ]) {
      expect(src).toContain(token);
    }
  }
  expect(analyticsViewSource).toContain(':time-format="bucketFmt"');
  expect(analyticsViewSource).toContain(':format="fmtPoint"');
  expect(llmPanelSource).toContain(':format="fmtTps"');
  expect(nodeDetailSource).toContain(':format="tipPct"');
  expect(nodeDetailSource).toContain(':format="fmtBytes"');
  expect(nodeDetailSource).toContain(':format="tipRate"');
  expect(cssSource).toContain(".charttip {");
  expect(cssSource).toContain("z-index: 6");
});
