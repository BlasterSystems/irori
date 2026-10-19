import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
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
    ]);
    expect(yaml).toContain("downloads:");
    expect(yaml).toContain('  - source: "Qwen/Qwen3-8B"');
    expect(yaml).toContain('    name: "qwen3-8b-vllm"');
    expect(yaml).toContain('    revision: "main"');
    expect(yaml).toContain('    quantization: "Q4_K_M"');
    expect(yaml).toContain('    runtime: "llama.cpp"');
    expect(yaml).toContain('    mmproj: "mmproj-F16.gguf"');
    expect(yaml).toContain("    force: true");
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

  it("maps push with repeated hosts and jobs", () => {
    const { argv } = buildCommand("push", { name: "glm", hosts: ["10.100.24.1", "10.100.25.1"], jobs: 8 }, ctx);
    expect(argv).toEqual(["modelctl", "push", "glm", "--host", "10.100.24.1", "--host", "10.100.25.1", "--jobs", "8"]);
  });

  it("maps push ssh and cache-dir overrides", () => {
    const { argv } = buildCommand("push", { name: "glm", hosts: ["deploy@10.0.10.9"], ssh: "/usr/bin/ssh", cacheDir: "/home/deploy/.cache/huggingface/hub" }, ctx);
    expect(argv).toEqual(["modelctl", "push", "glm", "--host", "deploy@10.0.10.9", "--cache-dir", "/home/deploy/.cache/huggingface/hub", "--ssh", "/usr/bin/ssh"]);
  });

  it("maps download from the store by owner/model id", () => {
    const { argv } = buildCommand("download", { name: "hf-internal-testing/tiny-random-LlamaForCausalLM" }, ctx);
    expect(argv).toEqual(["modelctl", "download", "hf-internal-testing/tiny-random-LlamaForCausalLM"]);
  });

  it("maps nas-delete dry-run vs armed", () => {
    expect(buildCommand("nas-delete", { name: "m" }, ctx).argv).toEqual(["modelctl", "delete", "m", "--root", "/mnt/nas"]);
    expect(buildCommand("nas-delete-apply", { name: "m" }, ctx).argv).toEqual(["modelctl", "delete", "m", "--apply", "--yes", "--root", "/mnt/nas"]);
  });

  it("maps cleanup verbs with targets and apply", () => {
    const { argv } = buildCommand("gc-objects", { targets: ["a/b/c"], apply: true }, ctx);
    expect(argv).toEqual(["modelctl", "gc-objects", "a/b/c", "--apply", "--root", "/mnt/nas"]);
  });

  it("provisions modelctl via uv with a version gate", () => {
    const { argv, shell } = buildCommand("modelctl-install", {}, ctx);
    expect(shell).toBe("bash");
    expect(argv[0]).toBe("bash");
    // Pinned release tag + PATH export + enforced minimum version.
    expect(argv[2]).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(argv[2]).toContain('uv tool install --force "git+https://github.com/piresbruno/modelctl@v0.20.1"');
    expect(argv[2]).toContain("sort -V");
    expect(() => buildCommand("modelctl-install", {}, { ...ctx, pin: "not-semver" })).toThrow(CommandBuildError);
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
