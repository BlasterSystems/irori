import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectUpdateState,
  readDgxOsVersion,
  readFirmwareUpdates,
  readOsPrettyName,
  readUnattendedUpgradesResult,
  readUpgradableCount,
} from "../src/updates.js";

/**
 * IRI-081 (IR-172): on-node update state — probe fixtures including the
 * absent-tooling case. The apt invocation is a SIMULATE (`-s`): no download,
 * no install, no package state change from any Irori code path.
 */

describe("readOsPrettyName", () => {
  it("parses PRETTY_NAME from /etc/os-release", async () => {
    const dir = await mkdtemp(join(tmpdir(), "irori-upd-"));
    await writeFile(join(dir, "os-release"), 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n');
    expect(await readOsPrettyName(join(dir, "os-release"))).toBe("Ubuntu 24.04.3 LTS");
    expect(await readOsPrettyName(join(dir, "absent"))).toBeNull();
  });
});

describe("readDgxOsVersion (IR-243)", () => {
  it("parses DGX_OS_VERSION — never the DGX_NAME marketing line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "irori-dgx-"));
    const p = join(dir, "dgx-release");
    await writeFile(p, 'DGX_NAME="DGX Spark"\nDGX_OS_VERSION="7.6.0"\nDGX_OS_LINE="DGX OS 7.6.0 (Ubuntu 24.04.3 LTS)"\n');
    expect(await readDgxOsVersion([p])).toBe("7.6.0");
  });

  it("parses the REAL DGX Spark image shape via DGX_OTA_VERSION (IR-257)", async () => {
    // Grounded: dgx3's /etc/dgx-release, 2026-11-15 — no DGX_OS_VERSION or
    // DGX_OS_LINE anywhere; the OTA level is the baseline-comparable version.
    const dir = await mkdtemp(join(tmpdir(), "irori-dgx-"));
    const p = join(dir, "dgx-release");
    await writeFile(p, [
      'DGX_NAME="DGX Spark"',
      'DGX_PRETTY_NAME="NVIDIA DGX Spark"',
      'DGX_SWBUILD_DATE="2026-01-26-16-04-58"',
      'DGX_SWBUILD_VERSION="7.4.0"',
      'DGX_COMMIT_ID="6c74fd3"',
      'DGX_PLATFORM="30KL000CBF"',
      'DGX_SERIAL_NUMBER="MP30JSZD"',
      "",
      'DGX_OTA_VERSION="7.6.0"',
      'DGX_OTA_DATE="Thu Oct 15 19:04:33 WEST 2026"',
      "",
    ].join("\n"));
    expect(await readDgxOsVersion([p])).toBe("7.6.0");
    // dgx1's shape: one OTA behind — must read 7.5.0, not the SWBUILD 7.4.0.
    const p2 = join(dir, "dgx1");
    await writeFile(p2, 'DGX_NAME="DGX Spark"\nDGX_SWBUILD_VERSION="7.4.0"\nDGX_OTA_VERSION="7.5.0"\n');
    expect(await readDgxOsVersion([p2])).toBe("7.5.0");
  });

  it("prefers DGX_OTA_VERSION over DGX_OS_LINE when both exist (IR-257)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "irori-dgx-"));
    const p = join(dir, "dgx-release");
    await writeFile(p, 'DGX_OS_LINE="DGX OS 7.6.0 (Ubuntu 24.04.3 LTS)"\nDGX_OTA_VERSION="7.7.0"\n');
    expect(await readDgxOsVersion([p])).toBe("7.7.0");
  });

  it("falls back to DGX_OS_LINE and bare 5.x-style lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "irori-dgx-"));
    const p = join(dir, "dgx-release");
    await writeFile(p, 'DGX_NAME="DGX Station"\nDGX_OS_LINE="DGX OS 5.5.0 (Ubuntu 20.04.4 LTS)"\n');
    expect(await readDgxOsVersion([p])).toBe("DGX OS 5.5.0 (Ubuntu 20.04.4 LTS)");
    const p2 = join(dir, "plain");
    await writeFile(p2, "DGX OS 5.5.0\n");
    expect(await readDgxOsVersion([p2])).toBe("DGX OS 5.5.0");
  });

  it("a keys-only file with no version and an absent file yield null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "irori-dgx-"));
    const p = join(dir, "dgx-release");
    await writeFile(p, 'DGX_NAME="DGX Spark"\n');
    expect(await readDgxOsVersion([p])).toBeNull();
    expect(await readDgxOsVersion([join(dir, "absent")])).toBeNull();
  });
});

describe("readFirmwareUpdates", () => {
  it("parses fwupdmgr get-updates --json devices with pending versions", () => {
    const json = JSON.stringify({
      Devices: [
        { Name: "UEFI dbx", UpdateVersion: "371" },
        { Name: "GPU", UpdateVersion: "580.178.04" },
        { Name: "EC", UpdateVersion: null }, // no pending update — skipped
      ],
    });
    expect(readFirmwareUpdates(json)).toEqual([
      { device: "UEFI dbx", toVersion: "371" },
      { device: "GPU", toVersion: "580.178.04" },
    ]);
  });

  it("returns empty for absent tooling and malformed output", () => {
    expect(readFirmwareUpdates(null)).toEqual([]);
    expect(readFirmwareUpdates("not json")).toEqual([]);
  });
});

describe("readUpgradableCount (apt-get -s upgrade)", () => {
  it("counts Inst lines only (Conf lines are not packages)", async () => {
    const sim = ["Reading package lists...", "Inst libssl (1.0 [upgradable])", "Conf libssl", "Inst cuda (2.0 [upgradable])"].join("\n");
    expect(await readUpgradableCount(sim)).toEqual({ count: 2, nvidiaDgxPending: 0, aptPresent: true });
  });

  it("counts the nvidia/dgx OTA subset separately (IR-258)", async () => {
    const sim = [
      "Inst libssl (1.0 [upgradable])",
      "Inst dgx-dashboard (0.39.3-5) [upgradable from: 0.29.2-2]",
      "Inst dgx-spark-ota-update-meta (26.09.3) [upgradable from: 26.09.2]",
      "Conf libssl",
      "Inst linux-headers-nvidia-hwe-24.04 (7.0.0-1025.26) [upgradable from: 7.0.0-1019.19]",
      "Inst libnvidia-egl-wayland1 (1.1.23) [upgradable from: 1.1.21]",
    ].join("\n");
    expect(await readUpgradableCount(sim)).toEqual({ count: 5, nvidiaDgxPending: 4, aptPresent: true });
  });

  it("absent tooling → null count and aptPresent false", async () => {
    expect(await readUpgradableCount(null)).toEqual({ count: null, nvidiaDgxPending: null, aptPresent: false });
  });
});

describe("readUnattendedUpgradesResult", () => {
  it("reads the newest result file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "irori-uu-"));
    await writeFile(join(dir, "20261101-0600"), "placeholder");
    await mkdir(join(dir, "20261103-0600"));
    await writeFile(join(dir, "20261103-0600", "result"), "All upgrades installed");
    expect(await readUnattendedUpgradesResult(dir)).toBe("All upgrades installed");
  });

  it("null when the log dir is absent", async () => {
    expect(await readUnattendedUpgradesResult(join(tmpdir(), "irori-absent-uu"))).toBeNull();
  });
});

describe("collectUpdateState", () => {
  it("absent tooling degrades to the update-tooling-absent posture inputs", async () => {
    // Explicit null probes = the tools are absent; the shape stays complete
    // (never throws, never blanks) and the test is environment-independent
    // (undefined would run the real probes — CI runners HAVE apt).
    const state = await collectUpdateState({ dpkgQueryOut: null, aptGetSimOut: null, fwupdmgrOut: null });
    expect(state.aptPresent).toBe(false);
    expect(state.upgradableCount).toBeNull();
    expect(state.nvidiaDgxPending).toBeNull();
    expect(state.firmwareUpdates).toEqual([]);
    expect(state.fwupdPresent).toBe(false);
    expect(typeof state.pendingReboot).toBe("boolean");
  });

  it("reports fwupd present when the probe ran (IR-256)", async () => {
    const state = await collectUpdateState({
      dpkgQueryOut: null,
      aptGetSimOut: null,
      fwupdmgrOut: JSON.stringify({ Devices: [{ Name: "UEFI dbx", UpdateVersion: "371" }] }),
    });
    expect(state.fwupdPresent).toBe(true);
    expect(state.firmwareUpdates).toEqual([{ device: "UEFI dbx", toVersion: "371" }]);
  });
});
