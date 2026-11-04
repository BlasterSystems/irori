import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CPU_CAP_UNIT,
  cpuCapScriptBody,
  cpuCapUnitBody,
  persistCpuCap,
  readCpuClocks,
  setCpuCap,
} from "../src/cpu-clocks.js";

/**
 * IRI-124: CPU clock ceilings over a fake cpufreq tree. GB10's shape is two
 * clusters (2,808 MHz efficiency cores, 3,900 MHz performance cores) — the
 * clamp cases below are the ones a naive "write the number" implementation
 * would get wrong.
 */

interface PolicySpec {
  name: string;
  cpus: string;
  minKHz: number;
  maxKHz: number;
  curMaxKHz: number;
}

// Real GB10 layout (probed on DGX-1, 2026-11-04): cpus 0-4 and 10-14 are the
// 2,808 MHz cluster, cpus 5-9 and 15-19 the 3,900 MHz one; every policy was
// capped at 2,000 MHz.
const GB10: PolicySpec[] = Array.from({ length: 20 }, (_, cpu) => {
  const fast = (cpu >= 5 && cpu <= 9) || cpu >= 15;
  return {
    name: `policy${cpu}`,
    cpus: String(cpu),
    minKHz: fast ? 1_378_000 : 338_000,
    maxKHz: fast ? 3_900_000 : 2_808_000,
    curMaxKHz: 2_000_000,
  };
});

let root = "";

async function writePolicies(specs: PolicySpec[]): Promise<void> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "irori-cpu-"));
  for (const spec of specs) {
    const dir = path.join(root, spec.name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "related_cpus"), `${spec.cpus}\n`);
    await fs.writeFile(path.join(dir, "cpuinfo_min_freq"), `${spec.minKHz}\n`);
    await fs.writeFile(path.join(dir, "cpuinfo_max_freq"), `${spec.maxKHz}\n`);
    await fs.writeFile(path.join(dir, "scaling_max_freq"), `${spec.curMaxKHz}\n`);
  }
}

async function ceiling(policy: string): Promise<number> {
  return Number.parseInt((await fs.readFile(path.join(root, policy, "scaling_max_freq"), "utf8")).trim(), 10);
}

beforeEach(async () => {
  root = "";
});

afterEach(async () => {
  if (root !== "") await fs.rm(root, { recursive: true, force: true });
});

describe("readCpuClocks", () => {
  it("groups the two GB10 clusters and reports the uniform ceiling", async () => {
    await writePolicies(GB10);
    const r = await readCpuClocks(root);
    expect(r.ok).toBe(true);
    expect(r.cpu?.capMHz).toBe(2000);
    expect(r.cpu?.policies).toHaveLength(2);
    const clusters = r.cpu!.policies;
    const low = clusters.find((c) => c.maxKHz === 2_808_000)!;
    const high = clusters.find((c) => c.maxKHz === 3_900_000)!;
    expect(low.cpus).toEqual([0, 1, 2, 3, 4, 10, 11, 12, 13, 14]);
    expect(high.cpus).toEqual([5, 6, 7, 8, 9, 15, 16, 17, 18, 19]);
    expect(high.curMaxKHz).toBe(2_000_000);
  });

  it("reports no cap when the policies disagree", async () => {
    await writePolicies([GB10[0]!, { ...GB10[19]!, curMaxKHz: 3_000_000 }]);
    const r = await readCpuClocks(root);
    expect(r.cpu?.capMHz).toBeNull();
  });

  it("returns cpu=null when the platform exposes no cpufreq", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "irori-cpu-empty-"));
    const r = await readCpuClocks(root);
    expect(r).toEqual({ ok: true, cpu: null, error: null });
  });
});

describe("setCpuCap", () => {
  it("applies a cap below both cluster maxima to every policy", async () => {
    await writePolicies(GB10);
    const r = await setCpuCap(1400, root);
    expect(r.ok).toBe(true);
    expect(await ceiling("policy0")).toBe(1_400_000);
    expect(await ceiling("policy19")).toBe(1_400_000);
    expect(r.cpu?.capMHz).toBe(1400);
  });

  it("clamps per cluster: 2800 caps the efficiency cluster and leaves the fast one", async () => {
    await writePolicies(GB10);
    const r = await setCpuCap(2800, root);
    expect(r.ok).toBe(true);
    expect(await ceiling("policy0")).toBe(2_800_000);
    // 2,800,000 < 3,900,000 — the fast cluster is capped too.
    expect(await ceiling("policy19")).toBe(2_800_000);
    await setCpuCap(3000, root);
    // 3,000 > 2,808: the efficiency cluster cannot go higher than its maximum.
    expect(await ceiling("policy0")).toBe(2_808_000);
    expect(await ceiling("policy19")).toBe(3_000_000);
  });

  it("never writes below a policy minimum", async () => {
    await writePolicies(GB10);
    await setCpuCap(100, root);
    expect(await ceiling("policy0")).toBe(338_000);
    expect(await ceiling("policy19")).toBe(1_378_000);
  });

  it("clear restores each policy's own maximum", async () => {
    await writePolicies(GB10);
    await setCpuCap(1400, root);
    const r = await setCpuCap(null, root);
    expect(r.ok).toBe(true);
    expect(await ceiling("policy0")).toBe(2_808_000);
    expect(await ceiling("policy19")).toBe(3_900_000);
    expect(r.cpu?.capMHz).toBeNull();
  });

  it("fails cleanly without policies", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "irori-cpu-none-"));
    const r = await setCpuCap(1400, root);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no cpufreq policies");
  });
});

describe("boot-time persistence", () => {
  it("bakes the cap into the re-apply script with the per-policy clamp", () => {
    const body = cpuCapScriptBody(2000);
    expect(body).toContain("cap=2000");
    expect(body).toContain('echo "$target" > "$p/scaling_max_freq"');
    expect(body).toContain("cpuinfo_max_freq");
    expect(body).toContain("# irori-managed");
  });

  it("installs the script + unit and enables the unit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "irori-cpu-unit-"));
    const calls: string[][] = [];
    const r = await persistCpuCap(2000, {
      unitDir: dir,
      scriptPath: path.join(dir, "cpu-clock-cap.sh"),
      runSystemctl: async (args) => {
        calls.push(args);
      },
    });
    expect(r).toEqual({ ok: true, error: null });
    const unit = await fs.readFile(path.join(dir, CPU_CAP_UNIT), "utf8");
    expect(unit).toContain(`ExecStart=/bin/sh ${dir}/cpu-clock-cap.sh`);
    expect(unit).toContain("WantedBy=multi-user.target");
    const script = await fs.readFile(path.join(dir, "cpu-clock-cap.sh"), "utf8");
    expect(script).toContain("cap=2000");
    expect(calls).toEqual([["enable", CPU_CAP_UNIT], ["daemon-reload"]]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a null cap removes the unit and the script", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "irori-cpu-unit-"));
    const scriptPath = path.join(dir, "cpu-clock-cap.sh");
    await persistCpuCap(1400, { unitDir: dir, scriptPath, runSystemctl: async () => {} });
    const calls: string[][] = [];
    const r = await persistCpuCap(null, {
      unitDir: dir,
      scriptPath,
      runSystemctl: async (args) => {
        calls.push(args);
      },
    });
    expect(r.ok).toBe(true);
    await expect(fs.readFile(path.join(dir, CPU_CAP_UNIT), "utf8")).rejects.toThrow();
    await expect(fs.readFile(scriptPath, "utf8")).rejects.toThrow();
    expect(calls).toEqual([["disable", CPU_CAP_UNIT], ["daemon-reload"]]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses to overwrite a foreign unit with the same name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "irori-cpu-foreign-"));
    await fs.writeFile(path.join(dir, CPU_CAP_UNIT), "[Unit]\nDescription=someone else\n");
    const r = await persistCpuCap(2000, { unitDir: dir, scriptPath: path.join(dir, "cpu-clock-cap.sh"), runSystemctl: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not irori-managed");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("unit body points at the script and stays root-run", () => {
    const unit = cpuCapUnitBody("/etc/irori/cpu-clock-cap.sh");
    expect(unit).toContain("ExecStart=/bin/sh /etc/irori/cpu-clock-cap.sh");
    expect(unit).toContain("Type=oneshot");
  });
});
