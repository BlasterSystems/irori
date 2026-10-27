import { describe, expect, it } from "vitest";
import { parsePushBlocked } from "../src/jobs-service.js";

const line = (l: string) => ({ seq: 0, line: l });

describe("parsePushBlocked", () => {
  it("detects each remediable gap (ADR-0014)", () => {
    expect(parsePushBlocked([line("IRORI_PREFLIGHT (dgx3): ssh auth failed — the transfer key is not authorized")])).toEqual({
      needsKeys: true,
      needsRsync: false,
      needsModelctl: false,
    });
    expect(parsePushBlocked([line("IRORI_PREFLIGHT (dgx3): destination rsync missing — the hub installs it")])).toEqual({
      needsKeys: false,
      needsRsync: true,
      needsModelctl: false,
    });
    expect(parsePushBlocked([line("IRORI_PREFLIGHT (dgx3): destination modelctl missing — provisioned automatically")])).toEqual({
      needsKeys: false,
      needsRsync: false,
      needsModelctl: true,
    });
  });

  it("combines gaps across hosts", () => {
    expect(
      parsePushBlocked([
        line("IRORI_PREFLIGHT (a): ssh auth failed — x"),
        line("IRORI_PREFLIGHT (b): destination rsync missing — y"),
      ]),
    ).toEqual({ needsKeys: true, needsRsync: true, needsModelctl: false });
  });

  it("returns null for unreachable hosts — nothing to provision", () => {
    expect(parsePushBlocked([line("IRORI_PREFLIGHT (dgx3): unreachable — Connection timed out")])).toBeNull();
  });

  it("returns null for non-preflight failures and empty output", () => {
    expect(parsePushBlocked([line("rsync: connection unexpectedly closed")])).toBeNull();
    expect(parsePushBlocked([])).toBeNull();
  });
});
