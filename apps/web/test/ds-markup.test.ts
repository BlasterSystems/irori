import { expect, it } from "vitest";
import nodeCardSource from "../src/components/NodeCard.vue?raw";
import nodeDetailSource from "../src/components/NodeDetail.vue?raw";
import sparklineSource from "../src/components/Sparkline.vue?raw";
import appSource from "../src/App.vue?raw";

/**
 * DOM-free DS fidelity guard: the components must use the mockup vocabulary
 * (irori.css classes) verbatim. Rendering tests need jsdom and are deferred.
 */
it("NodeCard keeps the DS card vocabulary", () => {
  for (const cls of ["card", "card__head", "card__body", "chip", "barrow", "bar__fill", "mono faint"]) {
    expect(nodeCardSource).toContain(cls);
  }
  expect(nodeCardSource).toContain(":class=\"card.dotClass\"");
  expect(nodeCardSource).toContain("waiting for first snapshot");
});

it("App keeps the DS topbar lockup, nav and empty state", () => {
  for (const cls of ["topbar__in", "brand-mark", "mark-node", "mark-line", "mark-square", "brand-name", "brand-endorsement", "nav", "is-active", "chip--ok", "pulse", "pagehead", "cols-3", "banner"]) {
    expect(appSource).toContain(cls);
  }
  expect(appSource).toContain("No nodes registered. Add a node in the server config / API.");
  expect(appSource).toContain("irori-theme");
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

it("Sparkline renders the DS .spark svg with token stroke colors", () => {
  for (const token of ["spark", "preserveAspectRatio=\"none\"", "stroke-width=\"1.5\"", "var(--ink-2)"]) {
    expect(sparklineSource).toContain(token);
  }
  expect(sparklineSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // no hard-coded hex
});
