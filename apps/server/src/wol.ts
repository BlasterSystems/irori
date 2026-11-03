import dgram from "node:dgram";

/**
 * IRI-068: Wake-on-LAN helpers (sparkDash-proven framing). Pure builders are
 * exported for tests; `sendWol` is the only side-effectful piece.
 */

const MAC_RE = /^([0-9a-f]{2}[:\-]){5}[0-9a-f]{2}$/;

/** Normalize a MAC to lowercase colon form; null when unusable. */
export function normalizeMac(mac: unknown): string | null {
  if (mac === null || mac === undefined) return null;
  const clean = String(mac).trim().toLowerCase();
  return MAC_RE.test(clean) ? clean.replaceAll("-", ":") : null;
}

/** /24 directed broadcast from an IPv4 literal, else the global broadcast. */
export function broadcastForLanIp(lanIp: unknown): string {
  if (typeof lanIp === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lanIp.trim())) {
    const nums = lanIp.trim().split(".").map((p) => Number(p));
    if (nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return `${nums[0]}.${nums[1]}.${nums[2]}.255`;
    }
  }
  return "255.255.255.255";
}

/** 6×0xFF followed by the MAC repeated 16 times. */
export function buildMagicPacket(cleanMac: string): Buffer {
  const macBytes = cleanMac.split(/[:\-]/).map((b) => Number.parseInt(b, 16));
  const magic = Buffer.alloc(6 + 16 * 6);
  magic.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) {
      magic[6 + i * 6 + j] = macBytes[j]!;
    }
  }
  return magic;
}

/** Send one magic packet; settles exactly once. */
export function sendWol(cleanMac: string, broadcastAddr = "255.255.255.255", port = 9): Promise<{ mac: string; broadcast: string }> {
  const magic = buildMagicPacket(cleanMac);
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = dgram.createSocket("udp4");
    const finish = (err: Error | null, result?: { mac: string; broadcast: string }): void => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      if (err !== null) reject(err);
      else resolve(result!);
    };
    sock.on("error", (err) => finish(err));
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        sock.send(magic, 0, magic.length, port, broadcastAddr, (err) => finish(err, { mac: cleanMac, broadcast: broadcastAddr }));
      } catch (err: unknown) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
