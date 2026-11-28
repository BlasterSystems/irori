import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStoreWriter, resolveStoreWriter } from "../src/models";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveStoreWriter (IRI-174)", () => {
  it("uses the local pick until the hub has answered", () => {
    expect(resolveStoreWriter("nas-1", null)).toEqual({ nodeId: "nas-1", reason: null });
    expect(resolveStoreWriter(null, null)).toEqual({ nodeId: null, reason: null });
  });

  it("lets the hub's answer win, including 'nobody may write'", () => {
    // NAS offline: the local pick falls back to a mounted Spark; the hub says no.
    expect(resolveStoreWriter("head-1", { nodeId: null, reason: "store node offline; no other node can safely write the store" })).toEqual({
      nodeId: null,
      reason: "store node offline; no other node can safely write the store",
    });
    expect(resolveStoreWriter("head-1", { nodeId: "nas-1", reason: null })).toEqual({ nodeId: "nas-1", reason: null });
  });
});

describe("fetchStoreWriter (IRI-174)", () => {
  const stub = (body: unknown): void => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })));
  };

  it("parses the hub's answer", async () => {
    stub({ nodeId: null, reason: "store node offline; no other node can safely write the store" });
    expect(await fetchStoreWriter()).toEqual({ nodeId: null, reason: "store node offline; no other node can safely write the store" });
  });

  it("rejects a malformed answer", async () => {
    stub({ node: "x" });
    await expect(fetchStoreWriter()).rejects.toThrow("malformed store-writer response");
  });
});
