import type { HfDraftKind, HfQuantsResult } from "@irori/core";

/**
 * IRI-154 (ADR-0020): the download modal's draft-companion preselection.
 * Pure so the precedence rules are unit-tested; ModelsView only renders it.
 */

/**
 * Mirrors modelctl `drafts.default_spec_type` (legacy-safe: MTP dirs and
 * unknown names → draft-mtp). modelctl only classifies `.gguf` files; other
 * paths fall back to draft-mtp there too (review F4: same precondition here).
 */
export function defaultDraftSpecType(path: string): string | null {
  if (!/[^/]\.gguf$/i.test(path)) return "draft-mtp";
  const parts = path.split("/");
  const dirs = parts.slice(0, -1).map((p) => p.toLowerCase());
  if (dirs.includes("mtp")) return "draft-mtp";
  const base = (parts.at(-1) ?? "").toLowerCase();
  if (base.startsWith("dflash2-") || base.startsWith("dflash-")) return null;
  if (base.startsWith("dspark-")) return "draft-dspark";
  if (base.startsWith("mtp-")) return "draft-mtp";
  const kindDir = [...dirs].reverse().find((d) => d === "dspark" || d === "dflash" || d === "dflash2");
  if (kindDir === "dspark") return "draft-dspark";
  if (kindDir === "dflash" || kindDir === "dflash2") return null;
  return "draft-mtp";
}

export interface DraftChoice {
  /** Value for the draft select ("" = modelctl auto-selects). */
  mtp: string;
  /** Where the preselection came from. */
  origin: "hint" | "default" | "none";
}

/** Preselection precedence: a run hint naming a listed candidate → modelctl's default → none. */
export function preselectDraft(listing: HfQuantsResult): DraftChoice {
  const candidates = new Set(listing.companions.mtp.candidates.map((c) => c.path));
  const hinted = listing.hints?.draft ?? null;
  if (hinted !== null && candidates.has(hinted)) return { mtp: hinted, origin: "hint" };
  const fallback = listing.companions.mtp.default;
  if (fallback !== null) return { mtp: fallback, origin: "default" };
  return { mtp: "", origin: "none" };
}

/**
 * The `draftSpecType` a row sends. The hint's spec type belongs to the hinted
 * draft only, and it's sent only when it differs from modelctl's derived default.
 * That keeps the field rare, because modelctl ≤ 0.24.0 rejects it batch-wide.
 */
export function draftSpecTypeToSend(listing: HfQuantsResult, selected: string): string | undefined {
  const hints = listing.hints;
  if (!hints || hints.draft === null || hints.specType === null || selected !== hints.draft) return undefined;
  return hints.specType === defaultDraftSpecType(selected) ? undefined : hints.specType;
}

/** The spec type modelctl will serve the selected draft with (for display). */
export function effectiveDraftSpecType(listing: HfQuantsResult, selected: string): string | null {
  if (selected === "") return null;
  return draftSpecTypeToSend(listing, selected) ?? defaultDraftSpecType(selected);
}

const KIND_LABELS: Record<HfDraftKind, string> = { mtp: "MTP", dspark: "DSpark", dflash: "DFlash", dflash2: "DFlash2" };

export function draftKindLabel(kind: HfDraftKind | null | undefined): string {
  return kind ? KIND_LABELS[kind] : "draft";
}

/** "README" / "docs · unsloth.ai" for the provenance line; null when no hint applies. */
export function hintProvenance(listing: HfQuantsResult): { label: string; url: string | null } | null {
  const h = listing.hints;
  if (!h || h.source === null) return null;
  if (h.source === "readme") return { label: "repo README", url: h.url };
  let host = "docs";
  try {
    host = h.url ? new URL(h.url).hostname : host;
  } catch {
    /* keep the generic label */
  }
  return { label: `docs · ${host}`, url: h.url };
}

/** Safe external link: only https URLs are ever bound to href. */
export function safeHref(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The model card's projector when it differs from modelctl's pick (informational: rows have no mmproj field). */
export function mmprojNote(listing: HfQuantsResult): string | null {
  const hinted = listing.hints?.mmproj ?? null;
  const { candidates, default: pick } = listing.companions.mmproj;
  if (hinted === null || hinted === pick) return null;
  // Review F3: no mmproj* candidates means modelctl downloads no projector at all.
  if (candidates.length === 0) return `the run instructions use ${hinted}; modelctl will not download a projector`;
  return pick === null
    ? `the run instructions use ${hinted}; modelctl needs an explicit projector choice`
    : `the run instructions use ${hinted}; modelctl will download ${pick}`;
}
