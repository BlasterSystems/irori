import { describe, expect, it } from "vitest";
import {
  deleteConfirmCopy,
  deleteRequestFor,
  filterModels,
  inventorySummary,
  leftoverLabel,
  orphanHint,
  orphanRowsFor,
  registerCopy,
  registerRequestFor,
  resumeCopy,
  resumeRequestFor,
  storeMountLabel,
  type DeleteTarget,
} from "../src/inventory";

const MODEL = { name: "glm-4", repository: "org/glm-4", runtime: "vllm", bytes: 2_000_000_000 };

describe("deleteRequestFor", () => {
  it("maps a store row to nas-delete-apply", () => {
    const target: DeleteTarget = { scope: "store", name: "glm-4", repository: "org/glm-4", bytes: 1 };
    expect(deleteRequestFor(target)).toEqual({ kind: "nas-delete-apply", params: { name: "glm-4" } });
  });

  it("maps a local row to delete-local as the cache owner", () => {
    const target: DeleteTarget = { scope: "local", name: "glm-4", repository: "org/glm-4", bytes: null, user: "piresbruno", cacheDir: "/home/piresbruno/.cache/huggingface/hub" };
    expect(deleteRequestFor(target)).toEqual({ kind: "delete-local", params: { name: "glm-4", user: "piresbruno" } });
  });

  it("maps a leftover to gc-objects with its three-part path", () => {
    const target: DeleteTarget = { scope: "leftover", name: "old", object: "/mnt/llms/models/org/repo/abc--def", target: "org/repo/abc--def", bytes: 1, error: null };
    expect(deleteRequestFor(target)).toEqual({ kind: "gc-objects", params: { targets: ["org/repo/abc--def"], apply: true } });
  });

  it("refuses a leftover without a derivable target", () => {
    const target: DeleteTarget = { scope: "leftover", name: null, object: "/weird/path", target: "", bytes: null, error: null };
    expect(deleteRequestFor(target)).toBeNull();
  });
});

describe("deleteConfirmCopy", () => {
  it("names the node-local cache and the store in the copy", () => {
    expect(
      deleteConfirmCopy({ scope: "local", name: "glm", repository: "o/r", bytes: null, user: "root", cacheDir: "/root/.cache/huggingface/hub" }),
    ).toMatchObject({ title: "Delete glm from root's cache?", danger: "Delete local copy" });
    expect(deleteConfirmCopy({ scope: "store", name: "glm", repository: "o/r", bytes: null })).toMatchObject({
      title: "Delete glm from the store?",
      danger: "Delete from store",
    });
    expect(deleteConfirmCopy({ scope: "leftover", name: null, object: "/x", target: "o/r/a--b", bytes: null, error: null }).danger).toBe("Remove leftover");
  });
});

describe("orphanRowsFor (IR-133)", () => {
  it("joins states onto orphans and defaults missing ones to unknown", () => {
    expect(
      orphanRowsFor({
        orphans: ["a/one", "b/two", "c/three"],
        orphanStates: [
          { repo: "b/two", state: "resumable" },
          { repo: "a/one", state: "adoptable" },
        ],
      }),
    ).toEqual([
      { repo: "a/one", state: "adoptable" },
      { repo: "b/two", state: "resumable" },
      { repo: "c/three", state: "unknown" },
    ]);
  });

  it("keeps pre-classification reports rendering as unknown (Register-only)", () => {
    expect(orphanRowsFor({ orphans: ["x/y"], orphanStates: [] })).toEqual([{ repo: "x/y", state: "unknown" }]);
    expect(orphanHint("unknown")).toBeNull();
    expect(orphanHint("resumable")).toContain("completed files are not re-copied");
  });
});

describe("resumeRequestFor (IR-133)", () => {
  it("maps a resumable orphan to a per-user sync-local job", () => {
    expect(resumeRequestFor("Mia-AiLab/GLM-5.3-EXL3-2.75bpw-TensorFold", "piresbruno")).toEqual({
      kind: "sync-local",
      params: { name: "Mia-AiLab/GLM-5.3-EXL3-2.75bpw-TensorFold", user: "piresbruno" },
    });
  });

  it("states the transfer continues from staging", () => {
    const copy = resumeCopy("o/r");
    expect(copy.danger).toBe("Resume transfer");
    expect(copy.body).toContain("not re-transferred");
  });
});

describe("registerRequestFor (IR-104)", () => {
  it("maps an orphan to a per-user register-local job", () => {
    expect(registerRequestFor("Mia-AiLab/GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit", "piresbruno")).toEqual({
      kind: "register-local",
      params: { name: "Mia-AiLab/GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit", user: "piresbruno" },
    });
  });

  it("states that nothing is transferred", () => {
    const copy = registerCopy("o/r");
    expect(copy.danger).toBe("Register");
    expect(copy.body).toContain("Nothing is transferred");
    expect(copy.body).toContain("refuses");
  });
});

describe("storeMountLabel", () => {
  const storage = [
    { mount: "/", fs: "ext4" },
    { mount: "/mnt/nas", fs: "cifs" },
  ];

  it("picks the longest mount prefix and its filesystem", () => {
    expect(storeMountLabel("/mnt/nas", storage)).toBe("/mnt/nas · cifs");
    expect(storeMountLabel("/mnt/nas/models", storage)).toBe("/mnt/nas · cifs");
  });

  it("falls back to the raw root when no mount matches", () => {
    expect(storeMountLabel("/srv/llms", storage)).toBe("/srv/llms");
    expect(storeMountLabel("/mnt/nas", null)).toBe("/mnt/nas");
  });
});

describe("model list helpers", () => {
  it("filters by name or repository, case-insensitively", () => {
    const rows = [MODEL, { name: "qwen", repository: "Qwen/Qwen3", runtime: "vllm", bytes: null }];
    expect(filterModels(rows, "GLM").map((m) => m.name)).toEqual(["glm-4"]);
    expect(filterModels(rows, "qwen/q").map((m) => m.name)).toEqual(["qwen"]);
    expect(filterModels(rows, "  ")).toHaveLength(2);
  });

  it("summarizes counts and known bytes only", () => {
    expect(inventorySummary([MODEL, { ...MODEL, name: "b", bytes: null }])).toBe("2 models · 2 GB");
    expect(inventorySummary([])).toBe("0 models");
  });

  it("labels a leftover by name, then by object basename", () => {
    expect(leftoverLabel({ name: "old", object: "/x/y", target: null, error: null, failedAt: null, bytes: null })).toBe("old");
    expect(leftoverLabel({ name: null, object: "/x/y/abc--def", target: null, error: null, failedAt: null, bytes: null })).toBe("abc--def");
  });
});
