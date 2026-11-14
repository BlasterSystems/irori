import { describe, expect, it } from "vitest";
import { inventoryStale } from "../src/inventory-service.js";
import { parseBaselineHtml } from "../src/updates-baseline.js";

/**
 * IRI-081 (IR-172): the upstream baseline parser — contract-tested against a
 * saved release-notes HTML fixture (the docs.nvidia.com anchors are
 * regex-verified: DGX OS 7.6.0, driver 580.178.04, kernel 7.0-1019, UEFI
 * 1.111.17, EC 3.13.7, SoC 2.158.15). A scrape failure degrades to
 * last-known-good; it never blanks the card. The per-node posture matrix
 * (tooling-absent / pending-reboot / behind) is covered by the agent probe
 * fixtures in updates-ir81.test.ts.
 */

const FIXTURE = `
<html><body><table>
<tr><td>DGX OS</td><td>7.6.0</td></tr>
<tr><td>Driver</td><td>580.178.04</td></tr>
<tr><td>Kernel</td><td>7.0-1019</td></tr>
<tr><td>UEFI</td><td>1.111.17</td></tr>
<tr><td>EC</td><td>3.13.7</td></tr>
<tr><td>SoC</td><td>2.158.15</td></tr>
</table></body></html>`;

describe("parseBaselineHtml", () => {
  it("extracts the six FE components from the release-notes fixture", () => {
    expect(parseBaselineHtml(FIXTURE)).toEqual({
      dgxOs: "7.6.0",
      driver: "580.178.04",
      kernel: "7.0-1019",
      uefi: "1.111.17",
      ec: "3.13.7",
      soc: "2.158.15",
    });
  });

  it("returns null for garbage (caller keeps last-known-good)", () => {
    expect(parseBaselineHtml("<html>nothing here</html>")).toBeNull();
  });
});

describe("inventoryStale (IR-243 daily sweep / IR-248 short-circuit)", () => {
  it("null entry and aged entries are stale; fresh ones are not", () => {
    expect(inventoryStale(null, 1_000, 60_000)).toBe(true);
    expect(inventoryStale({ updatedAt: new Date(30_000).toISOString() }, 90_000, 60_000)).toBe(true);
    expect(inventoryStale({ updatedAt: new Date(30_000).toISOString() }, 89_999, 60_000)).toBe(false);
  });
});
