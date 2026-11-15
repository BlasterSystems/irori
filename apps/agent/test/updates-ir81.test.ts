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
    expect(await readUpgradableCount(sim)).toEqual({ count: 2, aptPresent: true });
  });

  it("absent tooling → null count and aptPresent false", async () => {
    expect(await readUpgradableCount(null)).toEqual({ count: null, aptPresent: false });
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
