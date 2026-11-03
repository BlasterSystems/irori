import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * AES-256-GCM envelope: "v1:" + base64(iv(12) | authTag(16) | ciphertext).
 * Key is 32 bytes from ENCRYPTION_KEY hex (ADR-0002).
 */
const PREFIX = "v1:";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function generateToken(): string {
  const material = createHash("sha256").update(randomUUID()).update(randomUUID()).digest("hex");
  return "irn_" + material.slice(0, 40);
}

export function encryptSecret(keyHex: string, plaintext: string): string {
  const key = parseKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** Inverse of `encryptSecret`; throws on tampered or foreign-prefixed input. */
export function decryptSecret(keyHex: string, envelope: string): string {
  if (!envelope.startsWith(PREFIX)) throw new Error("unknown secret envelope");
  const key = parseKey(keyHex);
  const raw = Buffer.from(envelope.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function parseKey(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes of hex (64 chars)");
  return key;
}
