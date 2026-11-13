import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import benchmarksSource from "../src/components/BenchmarksView.vue?raw";
import serveSource from "../src/components/ServeView.vue?raw";

// vitest's css pipeline returns "" for *.css?raw — read the stylesheet directly.
const cssSource = readFileSync(new URL("../src/assets/irori.css", import.meta.url), "utf8");

/**
 * IR-218 component contracts under DS v1.1:
 * - a primary button is NEVER a pressed state — pressed filter chips are
 *   .bs-filter with aria-pressed (ink ring);
 * - one filled button per visible surface (pilot: BenchmarksView);
 * - the destructive action vocabulary is .bs-link--thread (thread, no fill);
 * - no elevation box-shadows anywhere — inset rings/lines are borders;
 * - the drawer focus contract (v-dialog: focus in, trap, Escape, restore)
 *   rides the shared directive and drawers carry aria-modal.
 */
it("BenchmarksView renders pressed filter chips as aria-pressed ink rings", () => {
  // The v1.0 idiom (btn--primary toggled on as the PRESSED state) is gone.
  expect(benchmarksSource).not.toContain("'btn--primary':");
  for (const token of ['class="bs-filter"', ':aria-pressed="decodeConc.includes(c)"', ':aria-pressed="prefillSizes.includes(s)"', ':aria-pressed="qualityCats.includes(c)"']) {
    expect(benchmarksSource).toContain(token);
  }
  // One filled button per surface: the Start-run action is the only fill.
  const fills = benchmarksSource.match(/btn--primary/g) ?? [];
  expect(fills.length).toBe(1);
});

it("irori.css ships the v1.1 action set and forbids elevation shadows", () => {
  for (const rule of [
    ".bs-filter { min-height: 36px; padding: 0 12px;",
    '.bs-filter[aria-pressed="true"] { box-shadow: inset 0 0 0 1.5px var(--ink); color: var(--ink); }',
    ".bs-link { display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0; background: none;",
    ".bs-link--thread { color: var(--thread-ink); }",
    ".btn { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 44px; padding: 0 18px;",
    ".btn--primary { background: var(--action-bg); color: var(--action-fg); }",
  ]) {
    expect(cssSource).toContain(rule);
  }
  // No box-shadow may carry an elevation: every value must be an inset ring/line.
  const shadows = cssSource.match(/box-shadow:\s*[^;]+/g) ?? [];
  expect(shadows.length).toBeGreaterThan(0);
  for (const s of shadows) expect(s.startsWith("box-shadow: inset")).toBe(true);
});

it("the setup drawer keeps the APG focus contract (v-dialog + aria-modal)", () => {
  expect(serveSource).toContain('role="dialog" aria-modal="true" aria-label="Setup details" v-dialog="closeDetail"');
});
