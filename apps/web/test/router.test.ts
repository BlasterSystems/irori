import { describe, expect, it } from "vitest";
import { nodeHash, parseHash } from "../src/router";

describe("parseHash", () => {
  it("parses #/node/:id into the node detail route", () => {
    expect(parseHash("#/node/00000000-0000-4000-8000-000000000001")).toEqual({
      view: "node",
      id: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("decodes an encoded node id", () => {
    expect(parseHash("#/node/spark%201")).toEqual({ view: "node", id: "spark 1" });
  });

  it("falls back to the overview for the root and unknown hashes", () => {
    expect(parseHash("")).toEqual({ view: "overview" });
    expect(parseHash("#/")).toEqual({ view: "overview" });
    expect(parseHash("#/nodes")).toEqual({ view: "overview" });
    expect(parseHash("#/node/a/b")).toEqual({ view: "overview" });
    expect(parseHash("junk")).toEqual({ view: "overview" });
  });

  it("round-trips nodeHash", () => {
    expect(parseHash(nodeHash("spark 1"))).toEqual({ view: "node", id: "spark 1" });
  });
});
