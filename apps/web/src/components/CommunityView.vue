<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchCommunity, type CommunityViewData } from "../api";

/** IRI-083: community intelligence — top topics, latest, releases, health. */
const data = ref<CommunityViewData | null>(null);
const error = ref<string | null>(null);
const period = ref<"day" | "week" | "month" | "all">("week");

const periodFiltered = (items: CommunityViewData["items"]): CommunityViewData["items"] => {
  if (period.value === "all") return items;
  const cutoff = Date.now() - (period.value === "day" ? 86_400_000 : period.value === "week" ? 7 * 86_400_000 : 30 * 86_400_000);
  return items.filter((i) => i.publishedAt === null || new Date(i.publishedAt).getTime() > cutoff);
};

const fmtDate = (iso: string | null): string => (iso === null ? "" : new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric" }));
const sourceChip = (s: { ok: boolean; breakerOpen: boolean }): string => (s.breakerOpen ? "chip chip--warn" : "chip");
const sourceLabel = (s: string): string => s.replace(/^atom:/, "").replace(/^feed:/, "").replace(/^forum:/, "");

async function curate(id: string, patch: { hidden?: boolean; pinned?: boolean; seen?: boolean }): Promise<void> {
  await fetch(`/api/v1/community/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (data.value !== null) data.value.items = data.value.items.filter((i) => !(i.id === id && patch.hidden === true));
}

onMounted(() => {
  const load = (): void => {
    void fetchCommunity()
      .then((d) => {
        data.value = d;
        error.value = null;
      })
      .catch(() => {
        error.value = "community feed unavailable (pollers degrade gracefully — a dead source never blocks the panel)";
      });
  };
  load();
  void setInterval(load, 300_000);
});
</script>

<template>
  <div class="grid grid--cards">
    <section class="card section-gap">
      <div class="card__head">
        <h3>Community</h3>
        <select v-model="period" class="input input--compact" aria-label="Period">
          <option value="day">day</option>
          <option value="week">week</option>
          <option value="month">month</option>
          <option value="all">all</option>
        </select>
      </div>
      <div class="card__body">
        <p v-if="error !== null" class="banner banner--warn">{{ error }}</p>
        <template v-if="data !== null">
          <div class="row" style="gap: 6px; flex-wrap: wrap;">
            <span v-for="s in data.sources" :key="s.source" class="chip" :class="sourceChip(s)" :title="`failures: ${s.failures}${s.breakerOpen ? ' · breaker open' : ''}`">{{ sourceLabel(s.source) }}{{ s.breakerOpen ? " · degraded" : "" }}</span>
            <span v-if="data.sources.length === 0" class="muted">no pollers reported yet</span>
          </div>
          <h4 style="margin: 12px 0 4px;">Top topics</h4>
          <div class="row" style="gap: 6px; flex-wrap: wrap;">
            <span v-for="t in data.topics.slice(0, 8)" :key="t.topic" class="chip">{{ t.topic }} · {{ t.count }}</span>
            <span v-if="data.topics.length === 0" class="muted">no topics clustered yet</span>
          </div>
          <h4 style="margin: 12px 0 4px;">Latest</h4>
          <div v-for="i in periodFiltered(data.items).slice(0, 25)" :key="i.id" class="row" style="align-items: flex-start; padding: 4px 0; gap: 8px;">
            <span class="mono faint" style="flex: none;">{{ fmtDate(i.publishedAt) }}</span>
            <span v-if="i.embedOnly" class="chip" title="X: identity-only row; body hydrates at view time">x</span>
            <a :href="i.canonicalUrl" target="_blank" rel="noopener noreferrer" style="min-width: 0;">{{ i.title }}</a>
            <span v-if="i.score !== null" class="faint mono">{{ i.score }}</span>
            <button class="btn btn--ghost" style="flex: none;" @click="curate(i.id, { seen: true })">{{ i.seen ? "" : "mark seen" }}</button>
            <button class="btn btn--ghost" style="flex: none;" @click="curate(i.id, { hidden: true })">hide</button>
          </div>
          <h4 style="margin: 12px 0 4px;">Releases <span class="faint">(engine + recipe watch — feeds recipe staleness)</span></h4>
          <div v-for="r in data.releases.slice(0, 15)" :key="r.id" class="row" style="align-items: flex-start; padding: 4px 0; gap: 8px;">
            <span class="mono faint" style="flex: none;">{{ fmtDate(r.publishedAt) }}</span>
            <span class="chip">{{ sourceLabel(r.source) }}</span>
            <a :href="r.canonicalUrl" target="_blank" rel="noopener noreferrer" style="min-width: 0;">{{ r.title }}</a>
          </div>
          <p v-if="data.releases.length === 0" class="muted">no releases fetched yet</p>
        </template>
      </div>
    </section>
  </div>
</template>
