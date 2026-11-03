import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateToken, sha256Hex } from "../src/crypto.js";

/**
 * IRI-084: unit tier for packages/db — the AES-256-GCM secret envelope
 * (ADR-0002) round-trip, tamper detection, and token material.
 */

const KEY = "a".repeat(64);

describe("secret envelope", () => {
  it("round-trips plaintext", () => {
    const env = encryptSecret(KEY, "ssh-password-λ");
    expect(env.startsWith("v1:")).toBe(true);
    expect(decryptSecret(KEY, env)).toBe("ssh-password-λ");
  });

  it("produces fresh IVs (same plaintext, different envelopes)", () => {
    expect(encryptSecret(KEY, "x")).not.toBe(encryptSecret(KEY, "x"));
  });

  it("rejects tampered ciphertext and foreign prefixes", () => {
    const env = encryptSecret(KEY, "x");
    const raw = Buffer.from(env.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptSecret(KEY, "v1:" + raw.toString("base64"))).toThrow();
    expect(() => decryptSecret(KEY, "v2:abc")).toThrow(/unknown secret envelope/);
  });

  it("rejects short keys", () => {
    expect(() => encryptSecret("abcd", "x")).toThrow();
  });
});

describe("token material", () => {
  it("tokens are prefixed, long and unique", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.startsWith("irn_")).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it("sha256Hex is the familiar digest", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
