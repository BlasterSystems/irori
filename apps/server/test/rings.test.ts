import { describe, expect, it } from "vitest";
import { createRings, RING_CAPACITY } from "../src/rings.js";
import { makeSnapshot } from "./helpers.js";

describe("rings", () => {
  it("returns undefined for a node without snapshots", () => {
    const rings = createRings();
    expect(rings.latest("node-a")).toBeUndefined();
  });

  it("returns the most recent snapshot", () => {
    const rings = createRings();
    const first = makeSnapshot();
    const second = makeSnapshot();
    rings.push("node-a", first);
    rings.push("node-a", second);
    expect(rings.latest("node-a")).toBe(second);
  });

  it("keeps nodes isolated", () => {
    const rings = createRings();
    const snapshot = makeSnapshot();
    rings.push("node-a", snapshot);
    expect(rings.latest("node-b")).toBeUndefined();
    expect(rings.latest("node-a")).toBe(snapshot);
  });

  it("caps capacity and keeps the newest entry readable", () => {
    const rings = createRings(16);
    const last = makeSnapshot();
    for (let i = 0; i < RING_CAPACITY; i++) rings.push("node-a", makeSnapshot());
    rings.push("node-a", last);
    expect(rings.latest("node-a")).toBe(last);
  });

  it("drops state on remove", () => {
    const rings = createRings();
    rings.push("node-a", makeSnapshot());
    rings.remove("node-a");
    expect(rings.latest("node-a")).toBeUndefined();
  });
});
