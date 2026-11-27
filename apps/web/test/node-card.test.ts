import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(new URL("../src/components/NodeCard.vue", import.meta.url), "utf8");

describe("NodeCard source pins (IR-103, IRI-159)", () => {
  it("keeps the prominent offline treatment and no status chip", () => {
    expect(SRC).toContain("offline-strip");
    expect(SRC).toContain("card--offline");
    expect(SRC).toContain("card__name");
    // The status chip is gone: no statusText / dot rendering in the card.
    expect(SRC).not.toContain("card.statusText");
    expect(SRC).not.toContain("card.dotClass");
  });

  it("declutters the head: no kind chip, no agent version, no inference line (IRI-159)", () => {
    expect(SRC).not.toContain("{{ card.kind }}");
    expect(SRC).not.toContain("Agent {{");
    expect(SRC).not.toContain("inferenceLine");
    // Role and drift chips stay — state, not identity.
    expect(SRC).toContain('chip--accent">{{ card.role }}');
    expect(SRC).toContain('chip--warn">update');
  });

  it("carries constants in tooltips and dual values for the touch fallback", () => {
    expect(SRC).toContain('class="tip nametip"');
    expect(SRC).toContain('class="tip rowtip"');
    expect(SRC).toContain(':data-tip="row.tip"');
    expect(SRC).toContain(":aria-label=\"card.identityTip\"");
    expect(SRC).toContain('class="v-compact"');
    expect(SRC).toContain('class="v-total"');
    expect(SRC).toContain("@media (hover: none)");
  });
});
