<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { fetchAudit, fetchEventJournal, type AuditFilters, type JournalFilters } from "../api";
import type { AuditEntry, AuditPage, EventJournalRowWire } from "@irori/core";
import {
  AUDIT_ACTOR_TABS,
  AUDIT_RANGE_TABS,
  auditActorChip,
  auditDomainOf,
  auditHashFor,
  auditOutcomeChip,
  auditRowTime,
  auditVerbOf,
  diffSides,
  parseAuditHash,
  type AuditFilterState,
} from "../audit-data";

/**
 * IRI-077 Audit: the durable record of who did what to what (audit_log) plus
 * the restart-surviving operational frames (event_journal). Filters round-trip
 * through the hash so per-entity links (NodeDetail, Serve, Hub settings) can
 * deep-link `#/audit?target=<id>`.
 */

const filters = ref<AuditFilterState>(parseAuditHash(typeof location === "undefined" ? "" : location.hash));
/** Text filters live in drafts; only Enter/blur commits (deep watch loads). */
const domainDraft = ref(filters.value.domain);
const qDraft = ref(filters.value.q);
const page = ref<AuditPage | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const expanded = ref<string | null>(null);
const loadingMore = ref(false);

/** Journal panel: opt-in so the common audit read stays one round-trip. */
const journalOpen = ref(false);
const journal = ref<EventJournalRowWire[]>([]);
const journalCursor = ref<number | null>(null);
const journalLoading = ref(false);
const journalError = ref<string | null>(null);
const journalType = ref("");

let loadSeq = 0;
let moreSeq = 0;
let journalSeq = 0;

function serverFilters(): AuditFilters {
  const f: AuditFilters = { range: filters.value.range };
  if (filters.value.actor !== "all") f.actor = filters.value.actor;
  if (filters.value.domain) f.domain = filters.value.domain;
  if (filters.value.targetId) f.targetId = filters.value.targetId;
  if (filters.value.q.trim()) f.q = filters.value.q.trim();
  return f;
}

async function load(): Promise<void> {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = null;
  expanded.value = null;
  try {
    const data = await fetchAudit(serverFilters());
    if (seq !== loadSeq) return;
    page.value = data;
  } catch (err) {
    if (seq !== loadSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
    page.value = null;
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  const cursor = page.value?.nextCursor;
  if (cursor === null || cursor === undefined || loadingMore.value) return;
  const seq = ++moreSeq;
  loadingMore.value = true;
  try {
    const data = await fetchAudit({ ...serverFilters(), cursor });
    if (seq !== moreSeq) return;
    page.value = { entries: [...(page.value?.entries ?? []), ...data.entries], nextCursor: data.nextCursor, total: data.total };
  } catch {
    // keep what we have; the button stays available to retry
  } finally {
    if (seq === moreSeq) loadingMore.value = false;
  }
}

/** A target id that looks like a node uuid doubles as the journal filter. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function journalNodeId(): string | null {
  return UUID_RE.test(filters.value.targetId) ? filters.value.targetId : null;
}

async function loadJournal(append = false): Promise<void> {
  const seq = ++journalSeq;
  journalLoading.value = true;
  journalError.value = null;
  const f: JournalFilters = { range: "24h", limit: 100 };
  const nodeId = journalNodeId();
  if (nodeId !== null) f.nodeId = nodeId;
  if (journalType.value) f.type = journalType.value;
  if (append && journalCursor.value !== null) f.cursor = journalCursor.value;
  try {
    const data = await fetchEventJournal(f);
    if (seq !== journalSeq) return;
    journal.value = append ? [...journal.value, ...data.events] : data.events;
    journalCursor.value = data.nextCursor;
  } catch (err) {
    if (seq !== journalSeq) return;
    journalError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === journalSeq) journalLoading.value = false;
  }
}

function toggleJournal(): void {
  journalOpen.value = !journalOpen.value;
  if (journalOpen.value && journal.value.length === 0) void loadJournal();
}

function toggle(row: AuditEntry): void {
  expanded.value = expanded.value === row.id ? null : row.id;
}

function setFilter(patch: Partial<AuditFilterState>): void {
  filters.value = { ...filters.value, ...patch };
}

const hasMore = computed(() => page.value?.nextCursor !== null && page.value?.nextCursor !== undefined);
const rowCount = computed(() => page.value?.entries.length ?? 0);

function syncHash(): void {
  const next = auditHashFor(filters.value);
  if (location.hash !== next) history.replaceState(null, "", next);
}

onMounted(() => {
  void load();
});

watch(
  filters,
  () => {
    syncHash();
    void load();
  },
  { deep: true },
);
</script>

<template>
  <div>
    <div class="pagehead">
      <div>
        <h1 style="font-size: 20px">Audit</h1>
        <p>Every hub mutation — who did what to what — and the durable operational event journal.</p>
      </div>
      <div class="row">
        <nav class="seg" aria-label="Actor">
          <button
            v-for="t in AUDIT_ACTOR_TABS"
            :key="t.value"
            :class="{ 'is-active': filters.actor === t.value }"
            @click="setFilter({ actor: t.value })"
          >{{ t.label }}</button>
        </nav>
        <nav class="seg" aria-label="Range">
          <button
            v-for="r in AUDIT_RANGE_TABS"
            :key="r.value"
            :class="{ 'is-active': filters.range === r.value }"
            @click="setFilter({ range: r.value })"
          >{{ r.label }}</button>
        </nav>
      </div>
    </div>

    <div class="row" style="margin-top: var(--space-3); gap: var(--space-2); flex-wrap: wrap">
      <input v-model="domainDraft" class="input" style="max-width: 180px" placeholder="domain (node, setup…)" aria-label="Domain filter" @keyup.enter="setFilter({ domain: domainDraft })" @blur="setFilter({ domain: domainDraft })" />
      <input v-model="qDraft" class="input" style="max-width: 260px" placeholder="search summary / action / target" aria-label="Search filter" @keyup.enter="setFilter({ q: qDraft })" @blur="setFilter({ q: qDraft })" />
      <span v-if="filters.targetId" class="chip chip--accent">
        target: {{ filters.targetId }}
        <button class="iconbtn" style="min-height: 0; padding: 0 4px" aria-label="Clear target filter" @click="setFilter({ targetId: '' })">✕</button>
      </span>
      <button class="btn btn--ghost" style="margin-left: auto" :aria-expanded="journalOpen" @click="toggleJournal">
        {{ journalOpen ? "Hide" : "Show" }} event journal
      </button>
    </div>

    <p v-if="error" class="faint" style="margin-top: 10px" role="alert">{{ error }}</p>

    <section class="card" style="margin-top: var(--space-4)">
      <div class="card__head">
        <h3 style="font-size: 15px">Actions</h3>
        <span class="mono faint">{{ rowCount }} shown · {{ page?.total ?? 0 }} matching · {{ filters.range }}</span>
      </div>
      <div class="card__body card__body--flush">
        <div v-if="loading && page === null" class="faint" style="padding: 12px">Loading…</div>
        <template v-else-if="page !== null">
          <div v-for="entry in page.entries" :key="entry.id" class="audit-row" :class="{ 'is-open': expanded === entry.id }">
            <button class="audit-row__head" :aria-expanded="expanded === entry.id" @click="toggle(entry)">
              <span class="mono faint" style="font-size: 11px" :title="entry.ts">{{ auditRowTime(entry.ts) }}</span>
              <span class="chip" :class="auditActorChip(entry.actor)">{{ entry.actor }}</span>
              <span class="chip" :class="auditOutcomeChip(entry)">{{ entry.outcome }}</span>
              <span class="mono audit-row__action">{{ auditDomainOf(entry.action) }}<strong>.{{ auditVerbOf(entry.action) }}</strong></span>
              <span v-if="entry.targetId !== null" class="faint mono" style="font-size: 11px">{{ entry.targetType }}/{{ entry.targetId.slice(0, 8) }}</span>
              <span class="audit-row__summary">{{ entry.summary }}</span>
            </button>
            <div v-if="expanded === entry.id" class="audit-row__body">
              <div class="audit-meta faint mono">
                {{ entry.actorDetail ?? "actor—" }} · {{ entry.requestId ?? `req—` }} · {{ entry.sourceAddr ?? "src—" }}
              </div>
              <p v-if="entry.error !== null" class="faint" role="alert" style="margin: 4px 0">error: {{ entry.error }}</p>
              <template v-if="diffSides(entry.before, entry.after) !== null">
                <div v-if="diffSides(entry.before, entry.after)!.hasDiff" class="audit-diff">
                  <div>
                    <div class="faint mono" style="font-size: 11px; margin-bottom: 4px">before</div>
                    <pre class="log" style="padding: 8px; font-size: 12px">{{ diffSides(entry.before, entry.after)!.before.text || "—" }}</pre>
                  </div>
                  <div>
                    <div class="faint mono" style="font-size: 11px; margin-bottom: 4px">after</div>
                    <pre class="log" style="padding: 8px; font-size: 12px">{{ diffSides(entry.before, entry.after)!.after.text || "—" }}</pre>
                  </div>
                </div>
                <p v-else class="faint" style="font-size: 12px">no before/after shape recorded (presence-only or summary-only action)</p>
              </template>
            </div>
          </div>
          <div v-if="rowCount === 0" class="faint" style="padding: 12px">No audited actions in this range{{ filters.targetId ? " for this target" : "" }}.</div>
          <div v-else-if="hasMore" style="padding: 10px 12px">
            <button class="btn btn--ghost" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? "Loading…" : "Load older" }}</button>
          </div>
        </template>
      </div>
    </section>

    <section v-if="journalOpen" class="card" style="margin-top: var(--space-4)">
      <div class="card__head">
        <h3 style="font-size: 15px">Event journal</h3>
        <span class="row" style="gap: var(--space-2)">
          <input v-model="journalType" class="input" style="max-width: 180px; height: 28px" placeholder="type (snapshot, …)" aria-label="Journal type filter" @keyup.enter="loadJournal()" />
          <span class="mono faint">{{ journal.length }} frames · last 24 h</span>
        </span>
      </div>
      <div class="card__body card__body--flush">
        <div v-if="journalLoading && journal.length === 0" class="faint" style="padding: 12px">Loading…</div>
        <p v-else-if="journalError" class="faint" role="alert" style="padding: 12px">{{ journalError }}</p>
        <template v-else>
          <div v-for="row in journal" :key="row.id" class="journal-row">
            <span class="mono faint" style="font-size: 11px" :title="row.ts">{{ auditRowTime(row.ts) }}</span>
            <span class="chip chip--muted">{{ row.type }}</span>
            <span v-if="row.nodeId !== null" class="faint mono" style="font-size: 11px">node/{{ row.nodeId.slice(0, 8) }}</span>
          </div>
          <div v-if="journal.length === 0 && !journalLoading" class="faint" style="padding: 12px">No journaled events in the last 24 h{{ journalType ? ` of type ${journalType}` : "" }}.</div>
          <div v-if="journalCursor !== null" style="padding: 10px 12px">
            <button class="btn btn--ghost" :disabled="journalLoading" @click="loadJournal(true)">{{ journalLoading ? "Loading…" : "Load older" }}</button>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.audit-row {
  border-bottom: 1px solid var(--border);
}
.audit-row:last-child {
  border-bottom: 0;
}
.audit-row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  padding: 8px 12px;
  cursor: pointer;
  color: inherit;
}
.audit-row__head:hover {
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
}
.audit-row.is-open > .audit-row__head {
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
}
.audit-row__action {
  font-size: 12px;
  white-space: nowrap;
}
.audit-row__summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--muted);
}
.audit-row__body {
  padding: 4px 12px 12px 12px;
}
.audit-meta {
  font-size: 11px;
}
.audit-diff {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin-top: 6px;
}
@media (max-width: 900px) {
  .audit-diff {
    grid-template-columns: 1fr;
  }
}
.journal-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
}
.journal-row:last-child {
  border-bottom: 0;
}
</style>
