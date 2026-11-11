import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { StatsFs } from "node:fs/promises";
import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gpuSnapshotSchema, hardwareSnapshotSchema } from "@irori/core";
import {
  buildGpuSnapshots,
  collect,
  cpuUsagePct,
  parseComputeAppsCsv,
  parseGpuCsv,
  parseMeminfo,
  parseMountOutput,
  parseNetstatIbn,
  parseProcMounts,
  parseProcNetDev,
  parseVramCsv,
  raplPowerW,
  readCpuTempC,
  readHwmonPowerW,
  readPerCoreClocksKHz,
  readRaplEnergyUj,
  readStorage,
  resolveUnifiedMemory,
  selectRealMounts,
  networkRates,
} from "../src/collector.js";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const FIXTURE_SYS = path.join(FIXTURES, "sys");
const FIXTURE_SYS2 = path.join(FIXTURES, "sys2");

/** sparkControl's proven row shape: 10 metrics + index,name,uuid. */
const GPU_ROW =
  "71, 95, 53.21, 120, 1501, 1740, 0x0000000000000000, 0x0000000000000000, " +
  "0x0000000000000000, 0x0000000000000000, 0, NVIDIA GB10, GPU-xyz";
const MI = 1024 * 1024;

describe("collect", () => {
  it("produces a schema-valid v2 snapshot on this host", async () => {
    const snapshot = await collect();

    const parsed = hardwareSnapshotSchema.parse(snapshot);

    expect(parsed.transport).toBe("ws");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.agentVersion).toMatch(/^0\./);
    expect(parsed.hostname.length).toBeGreaterThan(0);
    expect(parsed.cpu.cores).toBeGreaterThan(0);
    expect(parsed.cpu.model.length).toBeGreaterThan(0);
    expect(parsed.cpu.usagePct === null || (parsed.cpu.usagePct >= 0 && parsed.cpu.usagePct <= 100))
      .toBe(true);
    expect(parsed.cpu.tempC === null || typeof parsed.cpu.tempC === "number").toBe(true);
    expect(
      parsed.cpu.packagePowerW === null ||
        (typeof parsed.cpu.packagePowerW === "number" && parsed.cpu.packagePowerW >= 0),
    ).toBe(true);
    expect(
      parsed.cpu.perCoreClocksKHz === undefined ||
        (Array.isArray(parsed.cpu.perCoreClocksKHz) &&
          parsed.cpu.perCoreClocksKHz.every((khz) => khz >= 0)),
    ).toBe(true);
    expect(
      parsed.cpu.perCoreMaxClocksKHz === undefined ||
        (Array.isArray(parsed.cpu.perCoreMaxClocksKHz) &&
          parsed.cpu.perCoreMaxClocksKHz.every((khz) => khz >= 0)),
    ).toBe(true);
    expect(parsed.memory.totalBytes).toBeGreaterThan(0);
    expect(parsed.memory.usedBytes).toBeGreaterThan(0);
    expect(parsed.memory.usedBytes).toBeLessThanOrEqual(parsed.memory.totalBytes);
    if (parsed.memory.swapTotalBytes !== null) {
      expect(parsed.memory.swapUsedBytes).not.toBeNull();
      expect(parsed.memory.swapUsedBytes!).toBeLessThanOrEqual(parsed.memory.swapTotalBytes);
    }
    expect(parsed.memory.swapTotalBytes === null || parsed.memory.swapTotalBytes >= 0).toBe(true);
    expect(
      parsed.unifiedMemory === null ||
        (parsed.unifiedMemory.poolBytes > 0 && parsed.unifiedMemory.gpuReservedBytes === null),
    ).toBe(true);
    expect(parsed.uptimeS).toBeGreaterThanOrEqual(0);
  });

  it("reports no GPUs when nvidia-smi is unavailable, with storage and network populated", async () => {
    const snapshot = await collect();
    expect(snapshot.gpus).toEqual([]);

    // darwin: mount/netstat fallbacks; linux: /proc/mounts + /proc/net/dev.
    expect(snapshot.storage.length).toBeGreaterThanOrEqual(1);
    for (const fs of snapshot.storage) {
      expect(fs.totalBytes).toBeGreaterThan(0);
      expect(fs.usedBytes).toBeGreaterThanOrEqual(0);
    }
    expect(snapshot.network.length).toBeGreaterThanOrEqual(1);
    for (const net of snapshot.network) {
      expect(net.iface).not.toBe("lo");
      if (net.rxBps !== null) expect(net.rxBps).toBeGreaterThanOrEqual(0);
      if (net.txBps !== null) expect(net.txBps).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("parseGpuCsv", () => {
  it("parses the sparkControl query row (13 fields) into schema shape", () => {
    const gpus = parseGpuCsv(`${GPU_ROW}\n`);
    expect(gpus).toHaveLength(1);
    const gpu = gpuSnapshotSchema.parse(gpus[0]);
    expect(gpu.index).toBe(0);
    expect(gpu.name).toBe("NVIDIA GB10");
    expect(gpu.uuid).toBe("GPU-xyz");
    expect(gpu.tempC).toBe(71);
    expect(gpu.usagePct).toBe(95);
    expect(gpu.powerW).toBe(53.21);
    expect(gpu.powerLimitW).toBe(120);
    expect(gpu.smClockMHz).toBe(1501);
    expect(gpu.smClockMaxMHz).toBe(1740);
    expect(gpu.throttleReasons).toEqual([]);
    expect(gpu.memUsedBytes).toBeNull();
    expect(gpu.memTotalBytes).toBeNull();
    expect(gpu.processes).toEqual([]);
  });

  it("maps [N/A]/[Not Supported] cells to null (GB10 unified-memory shape)", () => {
    const gpus = parseGpuCsv(
      '[N/A], [N/A], [Not Supported], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], 0, "NVIDIA GB10", [N/A]\n',
    );
    expect(gpus).toHaveLength(1);
    const gpu = gpus[0]!;
    expect(gpu.usagePct).toBeNull();
    expect(gpu.tempC).toBeNull();
    expect(gpu.powerW).toBeNull();
    expect(gpu.powerLimitW).toBeNull();
    expect(gpu.smClockMHz).toBeNull();
    expect(gpu.smClockMaxMHz).toBeNull();
    expect(gpu.throttleReasons).toEqual([]);
    expect(gpu.uuid).toBeNull();
    expect(gpu.name).toBe("NVIDIA GB10");
  });

  it("maps active throttle-reason masks to short names", () => {
    const row = (hwThermal: string, swThermal: string, hwSlowdown: string, powerCap: string) =>
      parseGpuCsv(`71, 95, 53.21, 120, 1501, 1740, ${hwThermal}, ${swThermal}, ${hwSlowdown}, ${powerCap}, 0, NVIDIA GB10, GPU-xyz`)[0]!
        .throttleReasons;
    expect(row("0x0000000000000001", "0x0", "0x0", "0x0000000000000004")).toEqual([
      "thermal",
      "power",
    ]);
    expect(row("0x0", "0x0000000000000002", "0x0", "0x0")).toEqual(["thermal"]);
    expect(row("0x0", "0x0", "0x1", "0x0")).toEqual(["hw"]);
    // Some drivers print decimal, not hex — nonzero still means active.
    expect(row("1", "0", "0", "0")).toEqual(["thermal"]);
  });

  it("skips malformed rows and the old M1 7-field row shape", () => {
    const gpus = parseGpuCsv(
      ["garbage line with too few fields", "0, NVIDIA GB10, 37, 52, 2048, 12288, 25.50", "", GPU_ROW].join(
        "\n",
      ),
    );
    expect(gpus).toHaveLength(1);
    expect(gpus[0]!.index).toBe(0);
  });
});

describe("parseVramCsv", () => {
  it("converts MiB rows to bytes and keeps [N/A] null (GB10)", () => {
    expect(parseVramCsv("2048, 12288\n")).toEqual([
      { memUsedBytes: 2048 * MI, memTotalBytes: 12288 * MI },
    ]);
    expect(parseVramCsv("[N/A], [N/A]\n")).toEqual([{ memUsedBytes: null, memTotalBytes: null }]);
  });
});

describe("parseComputeAppsCsv", () => {
  it("parses pid/process_name/used_memory rows, nulls and same-pid sums", () => {
    const apps = parseComputeAppsCsv("123, python, 4096\n456, vllm, [N/A]\n789, python3 /usr/bin/server, 512\n123, python, 100\n");
    expect(apps).toEqual([
      { pid: 123, name: "python", memBytes: (4096 + 100) * MI },
      { pid: 456, name: "vllm", memBytes: null },
      { pid: 789, name: "python3 /usr/bin/server", memBytes: 512 * MI },
    ]);
  });
});

describe("buildGpuSnapshots", () => {
  it("merges the main query with VRAM rows and compute apps", () => {
    const gpus = buildGpuSnapshots(`${GPU_ROW}\n`, "2048, 12288\n", "123, python, 4096\n");
    expect(gpus).toHaveLength(1);
    expect(gpus[0]!.memUsedBytes).toBe(2048 * MI);
    expect(gpus[0]!.memTotalBytes).toBe(12288 * MI);
    expect(gpus[0]!.processes).toEqual([{ pid: 123, name: "python", memBytes: 4096 * MI }]);
  });

  it("keeps null VRAM and empty processes when those queries fail", () => {
    const gpus = buildGpuSnapshots(`${GPU_ROW}\n`, null, null);
    expect(gpus[0]!.memUsedBytes).toBeNull();
    expect(gpus[0]!.memTotalBytes).toBeNull();
    expect(gpus[0]!.processes).toEqual([]);
  });
});

describe("cpuUsagePct", () => {
  const cpu = (times: Partial<{ user: number; nice: number; sys: number; idle: number; irq: number }>): os.CpuInfo => ({
    model: "test",
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times },
  });

  it("returns 0 for an idle window and a busy fraction otherwise", () => {
    expect(cpuUsagePct([cpu({ sys: 10, idle: 100 })], [cpu({ sys: 10, idle: 200 })])).toBe(0);
    expect(cpuUsagePct([cpu({ sys: 10, idle: 100 })], [cpu({ sys: 20, idle: 200 })])).toBe(9.1);
  });

  it("returns null when no ticks elapsed", () => {
    expect(cpuUsagePct([cpu({ idle: 5 })], [cpu({ idle: 5 })])).toBeNull();
  });
});

describe("readCpuTempC (fixture hwmon dirs)", () => {
  it("prefers the CPU-labeled sensor even when another sensor is hotter", async () => {
    // coretemp: 45/52 °C; nvme: 61 °C — the CPU sensor must win.
    await expect(readCpuTempC(FIXTURE_SYS)).resolves.toBe(52);
  });

  it("falls back to the hottest temp*_input when no sensor is CPU-labeled", async () => {
    await expect(readCpuTempC(FIXTURE_SYS2)).resolves.toBe(61);
  });

  it("yields null without hwmon", async () => {
    await expect(readCpuTempC("/nonexistent-irori-fixture")).resolves.toBeNull();
  });
});

describe("RAPL package power", () => {
  it("sums top-level intel-rapl domains and ignores :N:M subdomains", async () => {
    await expect(readRaplEnergyUj(FIXTURE_SYS)).resolves.toBe(1_000_000 + 500_000);
    await expect(readRaplEnergyUj("/nonexistent-irori-fixture")).resolves.toBeNull();
  });

  it("converts the µJ delta over the sample window to watts", () => {
    expect(raplPowerW(1_000_000, 1_600_000, 200)).toBe(3);
    expect(raplPowerW(1_600_000, 1_000_000, 200)).toBeNull(); // wrap/reset
    expect(raplPowerW(null, 1_600_000, 200)).toBeNull();
    expect(raplPowerW(1_000_000, 1_600_000, 0)).toBeNull();
  });
});

describe("readHwmonPowerW (fixture dirs)", () => {
  it("reads power*_average in microwatts", async () => {
    await expect(readHwmonPowerW(FIXTURE_SYS)).resolves.toBe(12.3);
    await expect(readHwmonPowerW("/nonexistent-irori-fixture")).resolves.toBeNull();
  });
});

describe("readPerCoreClocksKHz (fixture dirs)", () => {
  it("sorts cores numerically (cpu10 after cpu2) and reports kHz", async () => {
    await expect(readPerCoreClocksKHz(FIXTURE_SYS)).resolves.toEqual([3_000_000, 2_900_000, 2_800_000]);
    await expect(readPerCoreClocksKHz("/nonexistent-irori-fixture")).resolves.toBeNull();
  });
});

describe("meminfo and unified-memory detection", () => {
  const meminfoText = [
    "MemTotal:       131072000 kB",
    "MemFree:         2048000 kB",
    "MemAvailable:    65536000 kB",
    "SwapTotal:       4194304 kB",
    "SwapFree:        1048576 kB",
    "SwapCached:            0 kB",
    "HugePages_Total:       0",
    "",
  ].join("\n");

  it("parses kB values to bytes, preferring MemAvailable", () => {
    const meminfo = parseMeminfo(meminfoText);
    expect(meminfo.memTotalBytes).toBe(131072000 * 1024);
    expect(meminfo.memAvailableBytes).toBe(65536000 * 1024);
    expect(meminfo.swapTotalBytes).toBe(4194304 * 1024);
    expect(meminfo.swapFreeBytes).toBe(1048576 * 1024);
  });

  it("detects unified memory when gpu[0] has no discrete VRAM total", () => {
    const meminfo = parseMeminfo(meminfoText);
    const unifiedGpus = buildGpuSnapshots(`${GPU_ROW}\n`, "[N/A], [N/A]\n", null);
    expect(resolveUnifiedMemory(unifiedGpus, meminfo)).toEqual({
      poolBytes: 131072000 * 1024,
      availableBytes: 65536000 * 1024,
      gpuReservedBytes: null,
    });
  });

  it("returns null for discrete GPUs, no GPUs, or missing meminfo", () => {
    const meminfo = parseMeminfo(meminfoText);
    const discreteGpus = buildGpuSnapshots(`${GPU_ROW}\n`, "2048, 12288\n", null);
    expect(resolveUnifiedMemory(discreteGpus, meminfo)).toBeNull();
    expect(resolveUnifiedMemory([], meminfo)).toBeNull();
    expect(resolveUnifiedMemory(buildGpuSnapshots(`${GPU_ROW}\n`, "[N/A], [N/A]\n", null), null))
      .toBeNull();
  });
});

describe("storage mounts", () => {
  const mountsText = [
    "sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0",
    "tmpfs /tmp tmpfs rw,nosuid,nodev 0 0",
    "overlay / overlay rw,lowerdir=x,upperdir=y 0 0",
    "/dev/nvme0n1p2 / ext4 rw,relatime 0 0",
    "/dev/nvme0n1p2 /mnt/disk ext4 rw,relatime 0 0",
    "/dev/loop0 /snap/core20 squashfs ro,nodev 0 0",
    "cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid 0 0",
    "/dev/sda1 /data btrfs rw,ssd 0 0",
    "proc /proc proc rw 0 0",
    "/dev/sdb1 /mnt/my\\040disk ext4 rw 0 0",
    "",
  ].join("\n");

  it("filters virtual filesystems, dedupes devices and unescapes mounts", () => {
    const real = selectRealMounts(parseProcMounts(mountsText));
    expect(real.map((m) => [m.device, m.mount])).toEqual([
      ["/dev/nvme0n1p2", "/"],
      ["/dev/sda1", "/data"],
      ["/dev/sdb1", "/mnt/my disk"],
    ]);
  });

  it("parses darwin mount output and drops devfs/autofs", () => {
    const darwinText = [
      "/dev/disk3s1s1 on / (apfs, local, journaled)",
      "devfs on /dev (devfs, local, nobrowse)",
      "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
      "/dev/disk3s5 on /System/Volumes/Data (apfs, local)",
    ].join("\n");
    const real = selectRealMounts(parseMountOutput(darwinText));
    expect(real.map((m) => [m.device, m.mount, m.fsType])).toEqual([
      ["/dev/disk3s1s1", "/", "apfs"],
      ["/dev/disk3s5", "/System/Volumes/Data", "apfs"],
    ]);
  });
});

describe("network counters", () => {
  const netDevText = [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "  eth0: 1000    10    0    0    0     0          0         0  2000    20    0    0    0     0       0          0",
    "    lo: 500     5    0    0    0     0          0         0   500     5    0    0    0     0       0          0",
    "  eth1: 10      1    0    0    0     0          0         0    20     2    0    0    0     0       0          0",
    "",
  ].join("\n");

  it("parses /proc/net/dev rows", () => {
    const counters = parseProcNetDev(netDevText);
    expect(counters.get("eth0")).toEqual({ rx: 1000, tx: 2000 });
    expect(counters.get("lo")).toEqual({ rx: 500, tx: 500 });
    expect(counters.get("eth1")).toEqual({ rx: 10, tx: 20 });
  });

  it("parses netstat -ibn link rows (darwin)", () => {
    const text = [
      "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
      "lo0        16384 <Link#1>      lo0                 1234     0     12345     1234     0      6789     0",
      "en0         1500 <Link#12>    34:36:3b:aa:bb:cc   2345     0   1000000     3456     0   2000000     0",
      "en0         1500 fe80::1%en0   fe80::1%en0         2345     0   1000000     3456     0   2000000     0",
    ].join("\n");
    const counters = parseNetstatIbn(text);
    expect(counters.size).toBe(2);
    expect(counters.get("en0")).toEqual({ rx: 1_000_000, tx: 2_000_000 });
    expect(counters.get("lo0")).toEqual({ rx: 12_345, tx: 6_789 });
  });

  it("computes per-interface rates, nulls for unseen ifaces, and skips lo", () => {
    const net0 = parseProcNetDev(netDevText);
    const net1 = new Map(net0);
    net1.set("eth0", { rx: 2000, tx: 2500 });
    net1.set("eth2", { rx: 999, tx: 999 });

    const rates = networkRates(net0, net1, 1000);
    expect(rates).toEqual([
      { iface: "eth0", rxBps: 1000, txBps: 500, speedMbps: null, operState: null, addrs: [] },
      { iface: "eth1", rxBps: 0, txBps: 0, speedMbps: null, operState: null, addrs: [] },
      { iface: "eth2", rxBps: null, txBps: null, speedMbps: null, operState: null, addrs: [] },
    ]);
    expect(networkRates(net0, net1, 0)).toEqual([]);
    expect(networkRates(net0, null, 1000)).toEqual([]);
  });
});

describe("fixture sanity", () => {
  it("fixture files are present (guards against accidental deletion)", () => {
    expect(readFileSync(path.join(FIXTURE_SYS, "class/hwmon/hwmon0/name"), "utf8").trim()).toBe(
      "coretemp",
    );
    expect(readFileSync(path.join(FIXTURE_SYS, "class/powercap/intel-rapl:0/energy_uj"), "utf8").trim()).toBe(
      "1000000",
    );
  });
});

describe("bounded storage reads (IR-206)", () => {
  const fakeStats: StatsFs = {
    type: 0,
    bsize: 4096,
    blocks: 100,
    bfree: 50,
    bavail: 50,
    files: 0,
    ffree: 0,
    favail: 0,
    fsid: 0,
    flag: 0,
    namemax: 255,
  };

  it("still produces a snapshot when a mount's statfs never resolves", async () => {
    const procRoot = mkdtempSync(path.join(os.tmpdir(), "irori-ir206-"));
    try {
      writeFileSync(
        path.join(procRoot, "mounts"),
        ["//nas.lan/llms /mnt/nas cifs rw 0 0", "/dev/nvme0n1p2 / ext4 rw 0 0"].join("\n"),
      );
      const asked: string[] = [];
      const storage = await readStorage(procRoot, undefined, {
        timeoutMs: 60,
        statfsImpl: (async (mount: string) => {
          asked.push(mount);
          if (mount === "/mnt/nas") return new Promise<StatsFs>(() => {}); // wedged CIFS: never returns
          return fakeStats;
        }) as unknown as typeof statfs,
      });
      // The wedged mount is still probed (a healthy NAS must report capacity),
      // the ext4 mount is asked too (parallel), and the snapshot ships.
      expect(asked).toEqual(["/mnt/nas", "/"]);
      expect(storage).toHaveLength(1);
      expect(storage[0]).toMatchObject({ mount: "/", totalBytes: 100 * 4096, usedBytes: 50 * 4096, fs: "ext4" });
    } finally {
      rmSync(procRoot, { recursive: true, force: true });
    }
  });

  it("skips statfs failures the same as timeouts", async () => {
    const procRoot = mkdtempSync(path.join(os.tmpdir(), "irori-ir206-"));
    try {
      writeFileSync(path.join(procRoot, "mounts"), "/dev/sda1 /data ext4 rw 0 0\n");
      const storage = await readStorage(procRoot, undefined, {
        timeoutMs: 60,
        statfsImpl: (async () => {
          throw Object.assign(new Error("stale automount"), { code: "ENOENT" });
        }) as unknown as typeof statfs,
      });
      expect(storage).toEqual([]);
    } finally {
      rmSync(procRoot, { recursive: true, force: true });
    }
  });
});
