import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { buildCommand, buildQueueYaml, CommandBuildError } from "../src/modelctl.js";
import { JobManager } from "../src/jobs.js";
import { parseCatalog } from "@irori/core";
import { parseManifestFields, readStore, scanStore } from "../src/catalog-read.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "store");
const ctx = { nasRoot: "/mnt/nas", pin: "0.20.1", serverUrl: "ws://hub/agent-ws" };

describe("buildQueueYaml", () => {
  it("emits field-ordered entries with force flags", () => {
    const yaml = buildQueueYaml([
      { source: "Qwen/Qwen3-8B", name: "qwen3-8b-vllm", revision: "main" },
      { source: "org/model-GGUF", name: "m-q4", quantization: "Q4_K_M", runtime: "llama.cpp", mmproj: "mmproj-F16.gguf", force: true },
      // IRI-016: explicit MTP/draft companion (subfolder path) rides through.
      { source: "unsloth/gemma-4-31B-it-GGUF", name: "g31-q4", quantization: "UD-Q4_K_XL", mtp: "MTP/mtp-gemma-4-31B-it-Q8_0.gguf" },
    ]);
    expect(yaml).toContain("downloads:");
    expect(yaml).toContain('  - source: "Qwen/Qwen3-8B"');
    expect(yaml).toContain('    name: "qwen3-8b-vllm"');
    expect(yaml).toContain('    revision: "main"');
    expect(yaml).toContain('    quantization: "Q4_K_M"');
    expect(yaml).toContain('    runtime: "llama.cpp"');
    expect(yaml).toContain('    mmproj: "mmproj-F16.gguf"');
    expect(yaml).toContain("    force: true");
    expect(yaml).toContain('  - source: "unsloth/gemma-4-31B-it-GGUF"');
    expect(yaml).toContain('    mtp: "MTP/mtp-gemma-4-31B-it-Q8_0.gguf"');
  });

  it("quotes scalars so newlines cannot inject extra entries", () => {
    const yaml = buildQueueYaml([{ source: "x\n  - source: evil" }]);
    const parsed = yaml.split("\n").filter((l) => l.trim().startsWith("-"));
    expect(parsed).toHaveLength(1); // the injected line stays inside the quoted scalar
    expect(yaml).toContain('"x\\n  - source: evil"');
  });

  it("rejects empty lists and missing sources", () => {
    expect(() => buildQueueYaml([])).toThrow(CommandBuildError);
    expect(() => buildQueueYaml([{ name: "x" } as never])).toThrow(CommandBuildError);
  });
});

describe("buildCommand", () => {
  it("maps sync-local with source root and jobs", () => {
    const { argv } = buildCommand("sync-local", { name: "glm", jobs: 4 }, ctx);
    expect(argv).toEqual(["modelctl", "sync-local", "glm", "--source-root", "/mnt/nas", "--jobs", "4"]);
  });

  it("wraps sync-local in runuser for the node's cache user (IR-101)", () => {
    const cacheCtx = {
      ...ctx,
      agentUser: "root",
      cacheUser: "operator",
      resolveLocalUser: (user: string) => ({ home: `/home/${user}`, binary: `/home/${user}/.local/bin/modelctl` }),
    };
    const { argv, shell } = buildCommand("sync-local", { name: "glm", jobs: 4 }, cacheCtx);
    expect(shell).toBeUndefined();
    expect(argv).toEqual([
      "runuser",
      "-u",
      "operator",
      "--",
      "env",
      "-u",
      "XDG_STATE_HOME",
      "-u",
      "HF_HOME",
      "-u",
      "HF_HUB_CACHE",
      "HOME=/home/operator",
      "PATH=/home/operator/.local/bin:/usr/local/bin:/usr/bin:/bin",
      "/home/operator/.local/bin/modelctl",
      "sync-local",
      "glm",
      "--source-root",
      "/mnt/nas",
      "--jobs",
      "4",
    ]);
  });

  it("keeps sync-local unwrapped when the cache user is the agent itself (IR-101)", () => {
    const selfCtx = { ...ctx, agentUser: "root", cacheUser: "root", resolveLocalUser: () => null };
    const { argv } = buildCommand("sync-local", { name: "glm" }, selfCtx);
    expect(argv).toEqual(["modelctl", "sync-local", "glm", "--source-root", "/mnt/nas"]);
  });

  it("fails sync-local with an actionable error when the cache user has no modelctl (IR-101)", () => {
    const brokenCtx = { ...ctx, agentUser: "root", cacheUser: "operator", resolveLocalUser: () => null };
    expect(() => buildCommand("sync-local", { name: "glm" }, brokenCtx)).toThrow(/no modelctl for cache user "operator"/);
  });

  it("wraps push in runuser for the source node's cache user (IR-101)", () => {
    const cacheCtx = {
      ...ctx,
      agentUser: "root",
      cacheUser: "operator",
      resolveLocalUser: (user: string) => ({ home: `/home/${user}`, binary: `/home/${user}/.local/bin/modelctl` }),
    };
    const { argv } = buildCommand("push", { name: "glm", hosts: ["operator@10.40.40.1"], jobs: 4 }, cacheCtx);
    expect(argv.slice(0, 13)).toEqual([
      "runuser",
      "-u",
      "operator",
      "--",
      "env",
      "-u",
      "XDG_STATE_HOME",
      "-u",
      "HF_HOME",
      "-u",
      "HF_HUB_CACHE",
      "HOME=/home/operator",
      "PATH=/home/operator/.local/bin:/usr/local/bin:/usr/bin:/bin",
    ]);
    expect(argv.slice(13)).toEqual([
      "/home/operator/.local/bin/modelctl",
      "push",
      "glm",
      "--host",
      "operator@10.40.40.1",
      "--jobs",
      "4",
    ]);
  });

  it("maps push with repeated hosts and jobs", () => {
    const { argv } = buildCommand("push", { name: "glm", hosts: ["10.40.40.1", "10.40.40.2"], jobs: 8 }, ctx);
    expect(argv).toEqual(["modelctl", "push", "glm", "--host", "10.40.40.1", "--host", "10.40.40.2", "--jobs", "8"]);
  });

  it("maps push ssh and cache-dir overrides", () => {
    const { argv } = buildCommand("push", { name: "glm", hosts: ["deploy@10.20.30.9"], ssh: "/usr/bin/ssh", cacheDir: "/home/deploy/.cache/huggingface/hub" }, ctx);
    expect(argv).toEqual(["modelctl", "push", "glm", "--host", "deploy@10.20.30.9", "--cache-dir", "/home/deploy/.cache/huggingface/hub", "--ssh", "/usr/bin/ssh"]);
  });

  it("maps download from the store by owner/model id", () => {
    const { argv } = buildCommand("download", { name: "hf-internal-testing/tiny-random-LlamaForCausalLM" }, ctx);
    expect(argv).toEqual(["modelctl", "download", "hf-internal-testing/tiny-random-LlamaForCausalLM"]);
  });

  it("maps nas-delete dry-run vs armed", () => {
    expect(buildCommand("nas-delete", { name: "m" }, ctx).argv).toEqual(["modelctl", "delete", "m", "--root", "/mnt/nas"]);
    expect(buildCommand("nas-delete-apply", { name: "m" }, ctx).argv).toEqual(["modelctl", "delete", "m", "--apply", "--yes", "--root", "/mnt/nas"]);
  });

  it("maps register-local with the store root and per-user runuser (IR-104)", () => {
    expect(buildCommand("register-local", { name: "m" }, ctx).argv).toEqual([
      "modelctl",
      "register-local",
      "m",
      "--source-root",
      "/mnt/nas",
    ]);
    const perUser = buildCommand("register-local", { name: "m", user: "operator" }, {
      ...ctx,
      resolveLocalUser: () => ({ home: "/home/operator", binary: "/home/operator/.local/bin/modelctl" }),
    });
    expect(perUser.raw).toBe(true);
    expect(perUser.argv.slice(0, 4)).toEqual(["runuser", "-u", "operator", "--"]);
    expect(perUser.argv.slice(-5)).toEqual([
      "/home/operator/.local/bin/modelctl",
      "register-local",
      "m",
      "--source-root",
      "/mnt/nas",
    ]);
    expect(() => buildCommand("register-local", { name: "m", user: "ghost" }, ctx)).toThrow(/unknown local cache user/);
    expect(() => buildCommand("register-local", {}, ctx)).toThrow(/needs name/);
    const noStore = { ...ctx, nasRoot: null };
    expect(() => buildCommand("register-local", { name: "m" }, noStore)).toThrow(/needs a NAS store root/);
  });

  it("maps cleanup verbs with targets and apply", () => {
    const { argv } = buildCommand("gc-objects", { targets: ["a/b/c"], apply: true }, ctx);
    expect(argv).toEqual(["modelctl", "gc-objects", "a/b/c", "--apply", "--root", "/mnt/nas"]);
  });

  it("provisions modelctl via uv with a version gate", () => {
    const { argv, shell } = buildCommand("modelctl-install", {}, ctx);
    expect(shell).toBe("bash");
    expect(argv[0]).toBe("bash");
    const script = argv[2]!;
    // Pinned release tag + PATH export + enforced minimum version.
    expect(script).toContain('export PATH="/root/.local/bin:$PATH"');
    expect(script).toContain('PIN="0.20.1"');
    expect(script).toContain('uv tool install --force "git+https://github.com/piresbruno/modelctl@v$PIN"');
    expect(script).toContain("sort -V");
    // IR-105: the skip-if-newer pre-check runs before the install — a stale
    // env pin on the node must never downgrade a newer binary.
    expect(script).toContain("skipping install");
    expect(script.indexOf("skipping install")).toBeLessThan(script.indexOf("uv tool install"));
    expect(() => buildCommand("modelctl-install", {}, { ...ctx, pin: "not-semver" })).toThrow(CommandBuildError);
  });

  it("provisions a cache user's modelctl via runuser (IR-105)", () => {
    const resolved = { home: "/home/operator", binary: "/home/operator/.local/bin/modelctl" };
    const built = buildCommand("modelctl-install", { user: "operator" }, { ...ctx, resolveLocalUser: () => resolved });
    expect(built.raw).toBe(true);
    expect(built.argv!.slice(0, 13)).toEqual([
      "runuser",
      "-u",
      "operator",
      "--",
      "env",
      "-u",
      "XDG_STATE_HOME",
      "-u",
      "HF_HOME",
      "-u",
      "HF_HUB_CACHE",
      "HOME=/home/operator",
      "PATH=/home/operator/.local/bin:/usr/local/bin:/usr/bin:/bin",
    ]);
    expect(built.argv![13]).toBe("bash");
    expect(built.argv![15]).toContain('export PATH="/home/operator/.local/bin:$PATH"');
    expect(() =>
      buildCommand("modelctl-install", { user: "ghost" }, { ...ctx, resolveLocalUser: () => null }),
    ).toThrow(/no modelctl for cache user "ghost"/);
  });

  it("errors without a store root and for unknown kinds", () => {
    expect(() => buildCommand("doctor", {}, { nasRoot: null, pin: "0.20.1" })).toThrow(CommandBuildError);
    expect(() => buildCommand("bogus-kind", {}, ctx)).toThrow(/unknown job kind/);
  });

  it("writes the queue YAML to a temp file for download jobs", () => {
    const { argv } = buildCommand("download-queue", { downloads: [{ source: "Qwen/Qwen3-8B", name: "q" }], jobs: 2 }, ctx);
    expect(argv[0]).toBe("modelctl");
    expect(argv[1]).toBe("queue");
    const yamlPath = argv[2]!;
    expect(existsSync(yamlPath)).toBe(true);
    expect(readFileSync(yamlPath, "utf8")).toContain('  - source: "Qwen/Qwen3-8B"');
    expect(argv).toContain("--jobs");
    expect(argv).toContain("--root");
    rmSync(yamlPath, { force: true });
  });
});

describe("delete-local cache owners (IRI-028)", () => {
  const userCtx = {
    ...ctx,
    agentUser: "root",
    resolveLocalUser: (user: string) =>
      user === "operator" ? { home: "/home/operator", binary: "/home/operator/.local/bin/modelctl" } : null,
  };

  it("runs the agent user directly", () => {
    const { argv } = buildCommand("delete-local", { name: "glm" }, userCtx);
    expect(argv).toEqual(["modelctl", "delete-local", "glm"]);
  });

  it("wraps another cache owner in runuser with the resolved binary", () => {
    const { argv } = buildCommand("delete-local", { name: "glm", user: "operator" }, userCtx);
    expect(argv.slice(0, 6)).toEqual(["runuser", "-u", "operator", "--", "env", "-u"]);
    expect(argv).toContain("HOME=/home/operator");
    expect(argv.slice(-3)).toEqual(["/home/operator/.local/bin/modelctl", "delete-local", "glm"]);
  });

  it("rejects an unknown user instead of guessing a path", () => {
    expect(() => buildCommand("delete-local", { name: "glm", user: "nobody" }, userCtx)).toThrow(/unknown local cache user/);
  });
});

describe("JobManager", () => {
  const outputs: Array<{ jobId: string; seq: number; line: string }> = [];
  const dones: Array<{ jobId: string; status: string; exitCode: number | null }> = [];
  const mgr = new JobManager(
    () => ctx,
    {
      onOutput: (jobId, seq, line) => outputs.push({ jobId, seq, line }),
      onDone: (jobId, status, exitCode) => dones.push({ jobId, status, exitCode }),
    },
  );

  afterEach(() => {
    outputs.length = 0;
    dones.length = 0;
  });

  it("reports invalid kinds as failed output instead of throwing", () => {
    expect(mgr.start("11111111-1111-4111-8111-111111111111", "bogus", {})).toBe(true);
    expect(outputs[0]?.line).toContain("error: unknown job kind");
    expect(dones[0]?.status).toBe("failed");
    expect(dones[0]?.exitCode).toBeNull();
  });

  it("refuses a second concurrent job", () => {
    expect(mgr.start("22222222-2222-4222-8222-222222222222", "doctor", {})).toBe(true);
    expect(mgr.start("33333333-3333-4333-8333-333333333333", "doctor", {})).toBe(false);
    mgr.cancel("22222222-2222-4222-8222-222222222222");
  });
});

describe("store reading", () => {
  const golden = parseCatalog(readFileSync(join(FIXTURES, "catalog.json"), "utf8"));

  it("reads the real catalog.json (127 models) with source=catalog", async () => {
    const read = await readStore(FIXTURES);
    expect(read.source).toBe("catalog");
    expect(read.entries.length).toBe(127);
    expect(read.entries.find((m) => m.name === "glm-5.3-flash-exl3-q4")?.repository).toBe("0xSero/GLM-5.3-Flash-EXL3-Q4");
  });

  it("parses modelctl manifests", () => {
    const mf = parseManifestFields(readFileSync(join(FIXTURES, "manifest-exl3.yaml"), "utf8"));
    expect(mf).toMatchObject({ name: "DeepSeek-V4-Flash-0731-EXL3-3.0bpw", repo: "0xSero/DeepSeek-V4-Flash-0731-EXL3-3.0bpw", revision: "main", format: "safetensors", runtimeType: "vllm" });
  });

  it("live-scans a store without a catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "irori-store-"));
    try {
      const obj = join(dir, "models", "unsloth", "DeepSeek-OCR-2", "abc123--vllm");
      mkdirSync(obj, { recursive: true });
      writeFileSync(join(obj, "model.safetensors"), "x");
      mkdirSync(join(dir, "manifests"), { recursive: true });
      writeFileSync(join(dir, "manifests", "deepseek-ocr-2.yaml"), "name: deepseek-ocr-2\nrepo: unsloth/DeepSeek-OCR-2\nrevision: main\nformat: safetensors\nruntime:\n  type: vllm\n");
      mkdirSync(join(dir, "active"), { recursive: true });
      symlinkSync(obj, join(dir, "active", "deepseek-ocr-2"));
      const scanned = await scanStore(dir);
      expect(scanned).toEqual([{ name: "deepseek-ocr-2", runtime: "vllm", repository: "unsloth/DeepSeek-OCR-2", bytes: expect.any(Number) }]);
      const read = await readStore(dir);
      expect(read.source).toBe("scan");
      expect(read.warning).toContain("no catalog.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("JobManager env (IRI-019)", () => {
  it("hands ctx.hfToken to modelctl as HF_TOKEN and omits it when empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "irori-hfenv-"));
    try {
      // Fake modelctl: prints the HF token it was handed (or UNSET).
      const script = join(dir, "modelctl");
      writeFileSync(script, "#!/bin/sh\necho \"HF_TOKEN=${HF_TOKEN-UNSET}\"\n", { mode: 0o755 });
      const outputs: string[] = [];

      const jobs = new JobManager(
        () => ({ nasRoot: dir, pin: "0", modelctlPath: script, hfToken: "hf_x", serverUrl: "" }),
        { onOutput: (_jobId, _seq, line) => outputs.push(line), onDone: () => {} },
      );
      expect(jobs.start("44444444-4444-4444-8444-444444444444", "doctor", {})).toBe(true);
      await vi.waitFor(() => expect(outputs.some((l) => l.startsWith("HF_TOKEN="))).toBe(true));
      expect(outputs.find((l) => l.startsWith("HF_TOKEN="))).toBe("HF_TOKEN=hf_x");

      // Empty ctx token → no HF_TOKEN in the child env at all. runStreaming
      // merges {...process.env, ...opts.env}, so neutralize any ambient
      // HF_TOKEN (an owner exporting one would otherwise leak it into the
      // assertion diff).
      const savedToken = process.env.HF_TOKEN;
      delete process.env.HF_TOKEN;
      try {
        const jobs2 = new JobManager(
          () => ({ nasRoot: dir, pin: "0", modelctlPath: script, hfToken: "", serverUrl: "" }),
          { onOutput: (_jobId, _seq, line) => outputs.push(line), onDone: () => {} },
        );
        expect(jobs2.start("55555555-5555-4555-8555-555555555555", "doctor", {})).toBe(true);
        await vi.waitFor(() => expect(outputs.filter((l) => l.startsWith("HF_TOKEN=")).length >= 2).toBe(true));
        expect(outputs.filter((l) => l.startsWith("HF_TOKEN=")).at(-1)).toBe("HF_TOKEN=UNSET");
      } finally {
        if (savedToken !== undefined) process.env.HF_TOKEN = savedToken;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
