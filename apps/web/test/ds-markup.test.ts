import { expect, it } from "vitest";
import nodeCardSource from "../src/components/NodeCard.vue?raw";
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
