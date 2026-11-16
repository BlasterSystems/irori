import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";

/**
 * IR-260: the agent self-reports the sha256 of the bundle file it is running
 * (argv[1]) so the hub can diff it against the artifact it serves. Only a
 * deployed bundle (.mjs) is reportable — a dev run from TypeScript sources
 * has no artifact counterpart — and any stat/read failure stays null so the
 * hub renders "unknown" instead of a wrong verdict.
 */
export function fileSha256Sync(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function selfBundleSha256Sync(argv: string[] = process.argv): string | null {
  const entry = argv[1];
  if (entry === undefined || !entry.endsWith(".mjs")) return null;
  try {
    return fileSha256Sync(realpathSync(entry));
  } catch {
    return null;
  }
}
