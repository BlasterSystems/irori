import { eq } from "drizzle-orm";
import { settings, type Db } from "@irori/db";

/**
 * IRI-081: upstream baseline for DGX Spark (Founders Edition). Scraped from
 * docs.nvidia.com release notes, cached in the settings table and refreshed
 * at most daily. A scrape failure degrades to the last-known-good row with a
 * staleness stamp — never blanks the card. Informational only: Irori never
 * installs or reboots.
 */

export interface UpdateBaseline {
  dgxOs: string | null;
  driver: string | null;
  kernel: string | null;
  uefi: string | null;
  ec: string | null;
  soc: string | null;
  source: "live" | "cache" | "none";
  fetchedAtMs: number | null;
}

const BASELINE_KEY = "update_baseline";
export const BASELINE_TTL_MS = 24 * 3_600_000;
const RELEASE_NOTES_URL = "https://docs.nvidia.com/dgx/dgx-spark/release-notes.html";

/** Regex-verified anchors of the current-software-versions table (FE boards). */
export function parseBaselineHtml(html: string, now = Date.now()): Omit<UpdateBaseline, "source" | "fetchedAtMs"> | null {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");
  const pick = (label: string): string | null => {
    const m = new RegExp(`${label}\\s*[:=]?\\s*([0-9][0-9a-zA-Z.\\-]{1,40})`, "i").exec(text);
    return m === null ? null : m[1]!;
  };
  const dgxOs = pick("DGX OS\\s*7?\\.?[0-9]") ?? pick("DGX OS");
  const driver = pick("Driver[\\s*]*[0-9]{3}");
  if (dgxOs === null && driver === null) return null;
  return {
    dgxOs: pick("DGX OS"),
    driver: pick("Driver"),
    kernel: pick("Kernel"),
    uefi: pick("UEFI"),
    ec: pick("EC"),
    soc: pick("SoC"),
  };
}

async function readCache(db: Db): Promise<UpdateBaseline | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, BASELINE_KEY)).limit(1);
  if (rows.length === 0) return null;
  try {
    const v = rows[0]!.value as Partial<UpdateBaseline>;
    if (typeof v.fetchedAtMs !== "number") return null;
    return { dgxOs: v.dgxOs ?? null, driver: v.driver ?? null, kernel: v.kernel ?? null, uefi: v.uefi ?? null, ec: v.ec ?? null, soc: v.soc ?? null, source: "cache", fetchedAtMs: v.fetchedAtMs };
  } catch {
    return null;
  }
}

async function writeCache(db: Db, baseline: Omit<UpdateBaseline, "source" | "fetchedAtMs">, now: number): Promise<void> {
  await db
    .insert(settings)
    .values({ key: BASELINE_KEY, value: { ...baseline, fetchedAtMs: now } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { ...baseline, fetchedAtMs: now } } });
}

export async function getUpdateBaseline(
  db: Db,
  fetchImpl: typeof fetch,
  opts: { force?: boolean; html?: string } = {},
): Promise<UpdateBaseline | null> {
  const cached = await readCache(db);
  const fresh = cached !== null && Date.now() - (cached.fetchedAtMs ?? 0) < BASELINE_TTL_MS;
  if (!opts.force && fresh) return { ...cached!, source: "cache" };
  let html = opts.html ?? null;
  try {
    if (html === null) {
      const res = await fetchImpl(RELEASE_NOTES_URL, { signal: AbortSignal.timeout(15_000) });
      html = res.ok ? await res.text() : null;
    }
  } catch {
    html = null;
  }
  const parsed = html === null ? null : parseBaselineHtml(html);
  if (parsed !== null) {
    await writeCache(db, parsed, Date.now());
    return { ...parsed, source: "live", fetchedAtMs: Date.now() };
  }
  // Scrape failure: last-known-good with its staleness stamp, never blank.
  return cached;
}
