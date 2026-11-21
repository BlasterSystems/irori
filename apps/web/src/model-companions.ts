import { draftKind, isCompanionsUnreadable, type StoreCompanions, type StoreCompanionsState } from "@irori/core";
import { defaultDraftSpecType, draftKindLabel } from "./draft-choice";
import { formatGiB } from "./models";

/**
 * IRI-155: an installed model's companions (ADR-0020) as the Models page
 * shows them. Pure so the wording is unit-tested; ModelsView only renders.
 * Owner decisions: unknown (`undefined`, an older agent) and known-none
 * (`null`) render nothing; unreadable renders only an info marker, never a
 * previously known value.
 */

/** The info marker's label (tooltip and accessible name). */
export const COMPANIONS_UNREADABLE_LABEL = "Cannot read the model's companion info from the NAS";

export function companionsUnreadable(companions: StoreCompanionsState | undefined): boolean {
  return isCompanionsUnreadable(companions);
}

/** Narrows to the readable companions object; null for unknown, none and unreadable. */
function readable(companions: StoreCompanionsState | undefined): StoreCompanions | null {
  return companions === undefined || companions === null || isCompanionsUnreadable(companions) ? null : companions;
}

export interface CompanionRow {
  /** The drawer's `kv` term. */
  label: "projector" | "draft";
  /** e.g. "DSpark · dspark-Inkling-2-Mini-Q8_0.gguf · 0.4 GiB · --spec-type draft-dspark". */
  text: string;
}

/** The spec type modelctl serves an installed draft with: the recorded value, else the kind default. */
export function installedSpecType(draft: NonNullable<StoreCompanions["draft"]>): string | null {
  return draft.specType ?? defaultDraftSpecType(draft.path);
}

export function companionRows(state: StoreCompanionsState | undefined): CompanionRow[] {
  const companions = readable(state);
  if (companions === null) return [];
  const rows: CompanionRow[] = [];
  const size = (bytes: number | null): string[] => (bytes === null ? [] : [formatGiB(bytes)]);
  if (companions.mmproj !== null) {
    rows.push({ label: "projector", text: [companions.mmproj.path, ...size(companions.mmproj.bytes)].join(" · ") });
  }
  if (companions.draft !== null) {
    const d = companions.draft;
    const kind = draftKind(d.path);
    const spec = installedSpecType(d);
    rows.push({
      label: "draft",
      text: [...(kind === null ? [] : [draftKindLabel(kind)]), d.path, ...size(d.bytes), ...(spec === null ? [] : [`--spec-type ${spec}`])].join(" · "),
    });
  }
  return rows;
}

export interface CompanionChip {
  label: "+draft" | "+mmproj";
  /** Hover text naming the file. */
  title: string;
}

export function companionChips(state: StoreCompanionsState | undefined): CompanionChip[] {
  const companions = readable(state);
  if (companions === null) return [];
  const chips: CompanionChip[] = [];
  if (companions.draft !== null) chips.push({ label: "+draft", title: `draft: ${companions.draft.path}` });
  if (companions.mmproj !== null) chips.push({ label: "+mmproj", title: `projector: ${companions.mmproj.path}` });
  return chips;
}
