import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildInventory,
  discoverUsers,
  objectTarget,
  parseDeleteJournal,
  parseLocalList,
  parseModelctlVersion,
  snapshotRootFromEntrypoint,
  userArgv,
} from "../src/inventory.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "irori-inv-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("discoverUsers", () => {
  it("keeps real home users and adds the agent user", () => {
    const passwd = [
      "root:x:0:0:root:/root:/bin/bash",
      "daemon:x:1:1::/usr/sbin:/usr/sbin/nologin",
      "operator:x:1000:1000::/home/operator:/bin/bash",
      "badline",
    ].join("\n");
    expect(discoverUsers(passwd, "root")).toEqual([
      { user: "root", home: "/root" },
      { user: "operator", home: "/home/operator" },
    ]);
  });

  it("adds the agent user when its passwd entry is missing", () => {
    expect(discoverUsers("operator:x:1000:1000::/home/operator:/bin/bash", "root").at(-1)?.user).toBe("root");
  });
});

describe("userArgv", () => {
  it("runs the agent user directly", () => {
    expect(userArgv("root", "root", "/root", "/root/.local/bin/modelctl", ["delete-local", "m"])).toEqual([
      "/root/.local/bin/modelctl",
      "delete-local",
      "m",
    ]);
  });

  it("wraps another cache owner in runuser with a clean env", () => {
    const argv = userArgv("operator", "root", "/home/operator", "/home/operator/.local/bin/modelctl", ["delete-local", "m"]);
    expect(argv.slice(0, 7)).toEqual(["runuser", "-u", "operator", "--", "env", "-u", "XDG_STATE_HOME"]);
    expect(argv).toContain("HOME=/home/operator");
    expect(argv).toContain("PATH=/home/operator/.local/bin:/usr/local/bin:/usr/bin:/bin");
    expect(argv.slice(-3)).toEqual(["/home/operator/.local/bin/modelctl", "delete-local", "m"]);
  });
});

describe("local payload parsing", () => {
  it("maps list --local rows and ignores malformed entries", () => {
    expect(
      parseLocalList(
        JSON.stringify([
          { name: "glm", runtime: "vllm", repository: "org/glm" },
          { runtime: "vllm" },
          null,
        ]),
      ),
    ).toEqual([{ name: "glm", runtime: "vllm", repository: "org/glm", bytes: null }]);
  });

  it("rejects a non-array document", () => {
    expect(() => parseLocalList("{}")).toThrow(/not an array/);
  });

  it("reads the version line", () => {
    expect(parseModelctlVersion("modelctl 0.20.1\n")).toBe("0.20.1");
    expect(parseModelctlVersion("nope")).toBeNull();
  });
});

describe("snapshotRootFromEntrypoint", () => {
  const commit = "a".repeat(40);

  it("returns the snapshot dir for a dir entrypoint", () => {
    expect(snapshotRootFromEntrypoint(`/c/models--o--r/snapshots/${commit}`)).toBe(`/c/models--o--r/snapshots/${commit}`);
  });

  it("returns the snapshot dir for a nested file entrypoint", () => {
    expect(snapshotRootFromEntrypoint(`/c/models--o--r/snapshots/${commit}/gguf/m.gguf`)).toBe(`/c/models--o--r/snapshots/${commit}`);
  });

  it("rejects paths that are not HF snapshots", () => {
    expect(snapshotRootFromEntrypoint("/mnt/llms/models/o/r/abc")).toBeNull();
    expect(snapshotRootFromEntrypoint(`/c/snapshots/not-a-commit/x`)).toBeNull();
  });
});

describe("failed delete journals", () => {
  const object = "/mnt/llms/models/org/repo/abc--def";

  it("parses a FAILED delete journal", () => {
    const journal = {
      operation: "delete",
      state: "FAILED",
      history: [
        { state: "PLANNED", repo: "org/repo", object },
        { state: "REFERENCE_REMOVED", object },
        { state: "FAILED", object, at: "2026-10-26T05:29:27Z", error: "PermissionError: [Errno 13]" },
      ],
    };
    expect(parseDeleteJournal("old", JSON.stringify(journal))).toEqual({
      name: "old",
      object,
      repo: "org/repo",
      error: "PermissionError: [Errno 13]",
      failedAt: "2026-10-26T05:29:27Z",
    });
  });

  it("ignores completed or malformed journals", () => {
    expect(parseDeleteJournal("old", JSON.stringify({ operation: "delete", history: [{ state: "COMPLETE" }] }))).toBeNull();
    expect(parseDeleteJournal("old", "not json")).toBeNull();
    expect(parseDeleteJournal("old", JSON.stringify({ operation: "update", history: [{ state: "FAILED", object }] }))).toBeNull();
  });

  it("derives the three-part gc-objects target", () => {
    expect(objectTarget("/mnt/llms", object, "org/repo")).toBe("org/repo/abc--def");
    expect(objectTarget("/mnt/llms", "/mnt/nas/models/org/repo/abc--def", "org/repo")).toBe("org/repo/abc--def");
    expect(objectTarget("/mnt/llms", "/other/place/abc--def", "org/repo")).toBe("org/repo/abc--def");
    expect(objectTarget("/mnt/llms", "/other/place/abc--def", null)).toBeNull();
  });
});

describe("buildInventory", () => {
  it("combines the store, failed-delete leftovers and a user cache", async () => {
    const dir = tempDir();
    const root = join(dir, "store");
    const object = join(root, "models/org/repo/abc--def");
    mkdirSync(object, { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(object, "w.bin"), "12345");
    writeFileSync(
      join(root, "catalog.json"),
      JSON.stringify({ schema: 3, models: [{ name: "glm", runtime: "vllm", repository: "org/glm", bytes: 100 }] }),
    );
    writeFileSync(
      join(root, "state/old.delete.json"),
      JSON.stringify({
        operation: "delete",
        state: "FAILED",
        history: [
          { state: "PLANNED", repo: "org/repo", object },
          { state: "FAILED", object, at: "2026-10-26T05:29:27Z", error: "EACCES" },
        ],
      }),
    );

    const home = join(dir, "home");
    const snapshot = join(home, ".cache/huggingface/hub/models--o--r/snapshots", "b".repeat(40));
    mkdirSync(snapshot, { recursive: true });
    // IR-104: an unregistered models--* dir must surface as an orphan.
    mkdirSync(join(home, ".cache/huggingface/hub/models--other--orphan"), { recursive: true });
    mkdirSync(join(home, ".cache/huggingface"), { recursive: true });
    writeFileSync(join(snapshot, "w.bin"), "1234567890");

    const exec = async (_file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (args.includes("--version")) return { stdout: "modelctl 0.20.1\n", stderr: "" };
      if (args[0] === "list") return { stdout: JSON.stringify([{ name: "loc", runtime: "vllm", repository: "o/r" }]), stderr: "" };
      if (args[0] === "path") return { stdout: `${snapshot}/w.bin\n`, stderr: "" };
      throw new Error(`unexpected argv: ${args.join(" ")}`);
    };

    const report = await buildInventory({
      nasRoot: root,
      modelctlPath: "/fake/modelctl",
      agentUser: "root",
      users: [{ user: "root", home }],
      exec,
      now: () => 42,
    });

    expect(report.generatedAtMs).toBe(42);
    expect(report.store?.source).toBe("catalog");
    expect(report.store?.models).toEqual([{ name: "glm", repository: "org/glm", runtime: "vllm", bytes: 100 }]);
    expect(report.store?.leftovers).toHaveLength(1);
    expect(report.store?.leftovers[0]).toMatchObject({ name: "old", target: "org/repo/abc--def", bytes: 5, error: "EACCES" });
    expect(report.local).toHaveLength(1);
    expect(report.local[0]).toMatchObject({ user: "root", modelctlVersion: "0.20.1", error: null });
    expect(report.local[0]?.models).toEqual([{ name: "loc", repository: "o/r", runtime: "vllm", bytes: 10 }]);
    expect(report.local[0]?.orphans).toEqual(["other/orphan"]);
  });

  it("reports a local-only node and per-cache errors", async () => {
    const dir = tempDir();
    const home = join(dir, "home");
    mkdirSync(join(home, ".cache/huggingface"), { recursive: true });
    const report = await buildInventory({
      nasRoot: null,
      modelctlPath: "/fake/modelctl",
      agentUser: "root",
      users: [{ user: "root", home }],
      exec: async () => {
        throw new Error("modelctl exploded");
      },
    });
    expect(report.store).toBeNull();
    expect(report.local[0]?.error).toMatch(/modelctl exploded/);
    expect(report.local[0]?.models).toEqual([]);
    expect(report.local[0]?.orphans).toEqual([]);
  });
});
