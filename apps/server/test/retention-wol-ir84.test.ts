import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, settings, type Db } from "@irori/db";
import { eq } from "drizzle-orm";
import { readBodyRetention, USAGE_BODY_RETENTION_KEY } from "../src/usage-retention.js";
import { broadcastForLanIp, buildMagicPacket, normalizeMac } from "../src/wol.js";

/**
 * IRI-084: db-gated tier for the body-retention setting (validation + clamp)
 * and the pure WoL helpers (MAC normalization, broadcast derivation, packet
 * layout: 6×0xFF then the MAC repeated 16×).
 */

const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

describe("wol helpers (pure)", () => {
  it("normalizes macs to lowercase colon-separated hex", () => {
    expect(normalizeMac("AA-BB-CC-DD-EE-FF")).toBe("aa:bb:cc:dd:ee:ff");
    expect(normalizeMac("aa:bb:cc:dd:ee:ff")).toBe("aa:bb:cc:dd:ee:ff");
    expect(normalizeMac("nope")).toBeNull();
  });

  it("derives the subnet broadcast from an IPv4 literal", () => {
    expect(broadcastForLanIp("192.168.1.20")).toBe("192.168.1.255");
    expect(broadcastForLanIp("not-an-ip")).toBe("255.255.255.255");
  });

  it("builds the 102-byte magic packet from a normalized mac", () => {
    const pkt = buildMagicPacket("aa:bb:cc:dd:ee:ff");
    expect(pkt).toHaveLength(102);
    expect(pkt.subarray(0, 6).every((b) => b === 0xff)).toBe(true);
    for (let i = 0; i < 16; i++) expect(pkt.subarray(6 + i * 6, 12 + i * 6).toString("hex")).toBe("aabbccddeeff");
  });
});

d("body retention setting (db)", () => {
  let db: Db;

  beforeAll(async () => {
    const handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
  });

  it("defaults when unset", async () => {
    const r = await readBodyRetention(db);
    expect(r.bodyCapBytes).toBe(16 * 1024 * 1024);
  });

  it("clamps invalid shapes to defaults instead of throwing", async () => {
    await db
      .insert(settings)
      .values({ key: USAGE_BODY_RETENTION_KEY, value: { bodyCapBytes: -5 } })
      .onConflictDoUpdate({ target: settings.key, set: { value: { bodyCapBytes: -5 } } });
    const r = await readBodyRetention(db);
    expect(r.bodyCapBytes).toBeGreaterThan(0);
    void randomUUID;
  });

  it("reads back a valid stored shape", async () => {
    await db
      .insert(settings)
      .values({ key: USAGE_BODY_RETENTION_KEY, value: { bodyCapBytes: 1024, partCapBytes: 512 } })
      .onConflictDoUpdate({ target: settings.key, set: { value: { bodyCapBytes: 1024, partCapBytes: 512 } } });
    const r = await readBodyRetention(db);
    expect(r).toEqual({ bodyCapBytes: 1024, partCapBytes: 512 });
    await db.delete(settings).where(eq(settings.key, USAGE_BODY_RETENTION_KEY));
  });
});
