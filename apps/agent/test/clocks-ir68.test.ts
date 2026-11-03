import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOCK_CAP_UNIT, clockCapUnitBody, persistClockCap } from "../src/clocks.js";

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
