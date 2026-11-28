import { describe, expect, it } from "vitest";
import type { NodeInventory } from "@irori/core";
import { storeLinkNote } from "../src/inventory";

const LINK_WARNING = "84 active entries are not visible as symlinks on this mount; sync from the store will not work for them (an SMB mount hides the store's symlinks; on the store host itself, run a repair check)";

function inv(opts: { unlinked?: string[]; warning?: string | null; versions?: Record<string, string | null> }): Pick<NodeInventory, "store" | "local"> {
  return {
    store: {
      root: "/mnt/nas",
      source: "catalog",
      warning: opts.warning ?? null,
      models: [],
      leftovers: [],
      ...(opts.unlinked === undefined ? {} : { unlinkedActive: opts.unlinked }),
    },
    local: Object.entries(opts.versions ?? {}).map(([user, modelctlVersion]) => ({
      user,
      home: `/home/${user}`,
      cacheDir: `/home/${user}/.cache/huggingface/hub`,
      modelctlVersion,
      error: null,
      models: [],
      orphans: [],
      orphanStates: [],
    })),
  };
}

const hidden = Array.from({ length: 84 }, (_, i) => `m${i}`);

describe("storeLinkNote (IRI-175)", () => {
  it("is a quiet note, not a warning, when the sync user's modelctl is 0.25.1+", () => {
    const note = storeLinkNote(inv({ unlinked: hidden, warning: LINK_WARNING, versions: { root: "0.25.1", piresbruno: "0.25.1" } }), "piresbruno");
    expect(note?.tone).toBe("note");
    expect(note?.text).toContain("84 of the store's links as directories");
    expect(note?.text).toContain("Syncing from the store works here: modelctl 0.25.1");
    expect(note?.text).not.toContain("will not work");
  });

  it("stays a warning, with the fix, when that modelctl is older or unknown", () => {
    for (const versions of [{ piresbruno: "0.25.0" }, { piresbruno: null }, {}] as Array<Record<string, string | null>>) {
      const note = storeLinkNote(inv({ unlinked: hidden, warning: LINK_WARNING, versions }), "piresbruno");
      expect(note?.tone).toBe("warn");
      expect(note?.text).toContain("will not work here");
      expect(note?.text).toContain("modelctl pin to 0.25.1");
    }
  });

  it("judges the user the sync runs as, not another user on the node", () => {
    const versions = { root: "0.25.1", piresbruno: "0.25.0" };
    expect(storeLinkNote(inv({ unlinked: ["m"], warning: LINK_WARNING, versions }), "piresbruno")?.tone).toBe("warn");
    // no cache user: the agent user (root) runs the sync
    expect(storeLinkNote(inv({ unlinked: ["m"], warning: LINK_WARNING, versions }), null)?.tone).toBe("note");
    expect(storeLinkNote(inv({ unlinked: ["m"], warning: LINK_WARNING, versions }), null)?.text).toContain("1 of the store's links as a directory");
  });

  it("shows any other store warning as it is, and nothing for a healthy view", () => {
    expect(storeLinkNote(inv({ unlinked: [], warning: "no catalog.json; scanned active/" }), null)).toEqual({ tone: "warn", text: "no catalog.json; scanned active/" });
    // hidden links, but the agent reported a different problem: that one wins
    expect(storeLinkNote(inv({ unlinked: hidden, warning: "catalog unreadable; scanned active/", versions: { root: "0.25.1" } }), null)?.text).toBe("catalog unreadable; scanned active/");
    expect(storeLinkNote(inv({ unlinked: [] }), null)).toBeNull();
    expect(storeLinkNote(inv({}), null)).toBeNull();
    expect(storeLinkNote({ store: null, local: [] }, null)).toBeNull();
  });
});
