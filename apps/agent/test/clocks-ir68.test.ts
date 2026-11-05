import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOCK_CAP_UNIT, clockCapUnitBody, persistClockCap, shouldPersist } from "../src/clocks.js";

/**
 * IRI-068 (IR-159): clock-cap persistence unit. The unit body is a pure
 * string (never shell-interpolated input — the cap is an integer); the
 * collision guard refuses foreign unit files; removal is idempotent.
 */

describe("clockCapUnitBody", () => {
  it("emits a oneshot with the cap baked in as an integer", () => {
    const body = clockCapUnitBody(1500);
    expect(body).toContain("ExecStart=/usr/bin/nvidia-smi -lgc 0,1500");
    expect(body).toContain("[Service]");
    expect(body).toContain("Type=oneshot");
  });

  it("never interpolates shell metacharacters (input is an int)", () => {
    const body = clockCapUnitBody(2100);
    expect(body).not.toMatch(/[;&|`$]/);
  });
});

describe("shouldPersist (IRI-068/IRI-124)", () => {
  it("installs a cap only when the caller asked for persistence", () => {
    expect(shouldPersist(2000, true, true)).toBe(true);
    expect(shouldPersist(2000, false, true)).toBe(false);
  });

  it("always removes the unit on a clear, even without the persist flag", () => {
    // "cleared live, re-applied at boot" has no coherent meaning — a stale
    // oneshot is how a cleared cap used to resurrect itself.
    expect(shouldPersist(null, false, true)).toBe(true);
    expect(shouldPersist(null, true, true)).toBe(true);
  });

  it("never touches the unit when the live apply failed", () => {
    // The cap is still in force; removing the unit would lose it at reboot.
    expect(shouldPersist(2000, true, false)).toBe(false);
    expect(shouldPersist(null, true, false)).toBe(false);
  });
});

describe("persistClockCap", () => {
  const noSystemctl = async (): Promise<void> => {};
  it("installs, refuses foreign units, and removes (idempotent clear)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "irori-cap-"));
    try {
      const install = await persistClockCap(1500, dir, noSystemctl);
      expect(install.ok).toBe(true);
      const body = await readFile(join(dir, CLOCK_CAP_UNIT), "utf8");
      expect(body).toContain("-lgc 0,1500");

      // A foreign unit with the same name is never overwritten.
      await writeFile(join(dir, CLOCK_CAP_UNIT), "[Unit]\nDescription=someone else");
      const foreign = await persistClockCap(1800, dir, noSystemctl);
      expect(foreign.ok).toBe(false);
      expect(foreign.error).toContain("not irori-managed");
      // The foreign content is untouched.
      expect(await readFile(join(dir, CLOCK_CAP_UNIT), "utf8")).toContain("someone else");

      // Removal is fine even when the file is absent.
      await rm(join(dir, CLOCK_CAP_UNIT), { force: true });
      const clear = await persistClockCap(null, dir, noSystemctl);
      expect(clear.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
