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
it("NodeCard and NodeDetail render the importance-ordered rows with the hot-temp accent", () => {
  for (const src of [nodeCardSource, nodeDetailSource]) {
    for (const token of [
      'v-for="row in card.rows"',
      ':key="row.key"',
      "isHotTemp(row.tempC)",
      "formatTemp(row.tempC)",
      "'temp--hot'",
    ]) {
      expect(src).toContain(token);
    }
  }
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

it("irori.css ships the shared drawer chrome and the temp accent", () => {
  for (const rule of [
    ".drawer-scrim { position: fixed; inset: 0; background: var(--overlay);",
    ".drawer { width: min(560px, 100%); max-height: 88vh; overflow: auto; padding: 14px;",
    ".temp--hot { color: var(--thread-ink); }",
  ]) {
    expect(cssSource).toContain(rule);
  }
});

it("ModelsView always queues downloads and shows the queue panel (IRI-014)", () => {
  for (const token of [
    "enqueueDownload({", // adds go through POST /downloads, never a direct node job
    "Download queue",
    "downloadStatusChip(e.status)",
    "retryEntry(e.id)",
    "removeEntry(e.id)",
    "Add to queue",
    "pickStoreNode(nodes.value)", // NAS-preferred store node (shared core policy)
    "clearInterval(queuePoll)",
  ]) {
    expect(modelsViewSource).toContain(token);
  }
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
