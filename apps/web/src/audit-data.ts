import { AUDIT_RANGES, type AuditActor, type AuditEntry, type AuditRange } from "@irori/core";

/**
 * Pure helpers for the Audit view (IRI-077). Kept out of the SFC so the
 * load-bearing logic — hash round-trip, filter serialization, before/after
 * diff projection — has a real test layer (repo convention: web tests are
 * pure-function + source guards, no component mounting).
 */

export const AUDIT_RANGE_TABS: ReadonlyArray<{ value: AuditRange; label: string }> = AUDIT_RANGES.map((r) => ({
  value: r,
  label: r === "1y" ? "1 yr" : r === "1h" ? "1 h" : r.endsWith("d") ? `${r.slice(0, -1)} d` : `${r.slice(0, -1)} h`,
}));

export const AUDIT_ACTOR_TABS: ReadonlyArray<{ value: AuditActor | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "hub", label: "Hub" },
  { value: "agent", label: "Agent" },
  { value: "client", label: "Client" },
  { value: "anonymous", label: "Anon" },
];

export interface AuditFilterState {
  range: AuditRange;
  actor: AuditActor | "all";
  domain: string;
  q: string;
  targetId: string;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilterState = { range: "7d", actor: "all", domain: "", q: "", targetId: "" };

const isRange = (v: string | null): v is AuditRange => (AUDIT_RANGES as readonly string[]).includes(v ?? "");
const isActor = (v: string | null): v is AuditActor | "all" => AUDIT_ACTOR_TABS.some((t) => t.value === v);

/** Parses `#/audit?range=…&actor=…&domain=…&q=…&target=…`; junk falls back. */
export function parseAuditHash(hash: string): AuditFilterState {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const q = h.startsWith("/audit?") ? h.slice("/audit?".length) : "";
  const params = new URLSearchParams(q);
  const range = params.get("range");
  const actor = params.get("actor");
  return {
    range: isRange(range) ? range : DEFAULT_AUDIT_FILTERS.range,
    actor: isActor(actor) ? actor : "all",
    domain: (params.get("domain") ?? "").slice(0, 64),
    q: (params.get("q") ?? "").slice(0, 128),
    // `target` is the per-entity link param (NodeDetail/Serve/HubSettings).
    targetId: (params.get("target") ?? "").slice(0, 64),
  };
}

export function auditHashFor(filters: Partial<AuditFilterState>): string {
  const params = new URLSearchParams();
  if (filters.range) params.set("range", filters.range);
  if (filters.actor && filters.actor !== "all") params.set("actor", filters.actor);
  if (filters.domain) params.set("domain", filters.domain);
  if (filters.q) params.set("q", filters.q);
  if (filters.targetId) params.set("target", filters.targetId);
  const s = params.toString();
  return s.length > 0 ? `#/audit?${s}` : "#/audit";
}

/** Per-entity deep link: Audit filtered to one node/setup/etc. */
export function auditTargetHash(targetId: string): string {
  return auditHashFor({ targetId });
}

/** Domain deep link: Audit scoped to one action domain (setup, settings…). */
export function auditDomainHash(domain: string): string {
  return auditHashFor({ domain });
}

export interface DiffSide {
  text: string;
}

/**
 * Before/after projection for one row: pretty JSON per side, and a
 * changed-flag computed from normalized JSON so key ordering never fakes a
 * diff. Null/undefined on both sides = no diff content at all.
 */
export function diffSides(before: unknown, after: unknown): { before: DiffSide; after: DiffSide; hasDiff: boolean } | null {
  if (before === null && after === null) return null;
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  const norm = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    try {
      return JSON.stringify(sortKeys(v), null, 2) ?? String(v);
    } catch {
      return String(v);
    }
  };
  const b = norm(before);
  const a = norm(after);
  const changed = b.replace(/\s+/g, "") !== a.replace(/\s+/g, "");
  return { before: { text: b }, after: { text: a }, hasDiff: changed };
}

/** `node.delete` → `delete`; the domain drives the row's chip. */
export const auditDomainOf = (action: string): string => action.split(".")[0] ?? action;
export const auditVerbOf = (action: string): string => action.split(".").slice(1).join(".") || action;

const ACTOR_CHIP: Record<AuditActor, string> = {
  hub: "chip--accent",
  agent: "",
  client: "chip--muted",
  anonymous: "chip--warn",
};
export const auditActorChip = (actor: AuditActor): string => ACTOR_CHIP[actor];

export const auditOutcomeChip = (entry: Pick<AuditEntry, "outcome">): string => (entry.outcome === "ok" ? "chip--ok" : "chip--warn");

/** Compact local timestamp for row heads; full ISO lives in the title attr. */
export function auditRowTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
