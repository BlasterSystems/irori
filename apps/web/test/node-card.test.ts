import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(new URL("../src/components/NodeCard.vue", import.meta.url), "utf8");

describe("NodeCard source pins (IR-103)", () => {
  it("drops the status chip and carries the prominent offline treatment", () => {
    expect(SRC).toContain("offline-strip");
    expect(SRC).toContain("card--offline");
    expect(SRC).toContain("card__name");
    // The status chip is gone: no statusText / dot rendering in the card.
    expect(SRC).not.toContain("card.statusText");
    expect(SRC).not.toContain("card.dotClass");
  });
});
