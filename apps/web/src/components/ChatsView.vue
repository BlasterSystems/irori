<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { fetchChat, fetchChats, type UsageRangeName } from "../api";
import { fmtTimeIso, fmtTokens, parseUsageHash, clientLabel, USAGE_RANGE_TABS } from "../usage";
import type { ChatDetail, ChatSession, ChatsResponse } from "@irori/core";

/**
 * IR-53 Chats: sessions per client/day reconstructed from stored bodies
 * (IR-52). Without retention the page guides instead of erroring.
 */

const range = ref<UsageRangeName>("24h");
const loading = ref(false);
const error = ref<string | null>(null);
const chats = ref<ChatsResponse | null>(null);
const selected = ref<ChatSession | null>(null);
const detail = ref<ChatDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);

const sessionLabel = (s: ChatSession): string => clientLabel({ clientName: s.clientName, clientProject: s.clientProject, sourceAddr: s.sourceAddrs[0] ?? null });

const dayGrouped = computed<Array<{ day: string; sessions: ChatSession[] }>>(() => {
  const groups = new Map<string, ChatSession[]>();
  for (const s of chats.value?.sessions ?? []) {
    const day = new Date(s.startMs).toISOString().slice(0, 10);
    const list = groups.get(day) ?? [];
    list.push(s);
    groups.set(day, list);
  }
  return [...groups.entries()].map(([day, sessions]) => ({ day, sessions }));
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await fetchChats(range.value);
    chats.value = data;
    if (selected.value !== null && !data.sessions.some((s) => s.id === selected.value!.id)) {
      selected.value = null;
      detail.value = null;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function open(session: ChatSession): Promise<void> {
  selected.value = session;
  detailLoading.value = true;
  detailError.value = null;
  detail.value = null;
  try {
    const data = await fetchChat(session.id);
    if (data === null) detailError.value = "conversation not found";
    else detail.value = data;
  } catch (err) {
    detailError.value = err instanceof Error ? err.message : String(err);
  } finally {
    detailLoading.value = false;
  }
}

function syncHash(): void {
  if (location.hash !== "#/chats") history.replaceState(null, "", "#/chats");
}

onMounted(() => {
  const parsed = parseUsageHash(typeof location === "undefined" ? "" : location.hash);
  range.value = parsed.range as UsageRangeName;
  void load();
});

watch(range, () => {
  syncHash();
  void load();
});

const turnRole = (turn: ChatDetail["turns"][number]): string => {
  if (turn.kind === "response") return "assistant";
  if (turn.kind === "error") return "error";
  if (turn.kind === "marker") return "system";
  return turn.role ?? "unknown";
};

const hasRetentionHint = computed(() => (chats.value?.capturedWithoutBodies ?? 0) > 0 && (chats.value?.sessions.length ?? 0) === 0);
</script>

<template>
  <div>
    <div class="pagehead">
      <div>
        <h1 style="font-size: 20px">Chats</h1>
        <p>Reconstructed conversations from retained request bodies (IR-53).</p>
      </div>
      <div class="row">
        <nav class="seg" aria-label="Range">
          <button v-for="r in USAGE_RANGE_TABS" :key="r.value" :class="{ 'is-active': range === r.value }" @click="range = r.value">{{ r.label }}</button>
        </nav>
      </div>
    </div>

    <p v-if="error" class="faint" style="margin-top: 10px" role="alert">{{ error }}</p>

    <div class="cols chats-grid" style="margin-top: var(--space-4)">
      <!-- Session list: per client/day -->
      <section class="card">
        <div class="card__head"><h3 style="font-size: 15px">Sessions</h3><span class="mono faint">{{ chats?.sessions.length ?? 0 }} · {{ range }}</span></div>
        <div class="card__body card__body--flush">
          <div v-if="loading && chats === null" class="faint" style="padding: 12px">Loading…</div>
          <template v-else>
            <div v-for="g in dayGrouped" :key="g.day" class="chat-day">
              <div class="faint mono" style="font-size: 11px; padding: 8px 12px 2px">{{ g.day }}</div>
              <button
                v-for="s in g.sessions"
                :key="s.id"
                class="chat-row"
                :class="{ 'is-active': selected?.id === s.id }"
                @click="open(s)"
              >
                <span class="chat-row__main">
                  <span class="mono">{{ sessionLabel(s) }}</span>
                  <span v-if="s.clientAgentType !== null" class="chip" :class="s.clientAgentType === 'main' ? 'chip--accent' : 'chip--muted'">{{ s.clientAgentType }}</span>
                  <span v-if="s.compacted" class="chip chip--warn" title="context compaction detected">compacted</span>
                </span>
                <span class="faint mono" style="font-size: 11px">
                  {{ s.requests }} req · {{ s.messages }} msg · {{ fmtTokens(s.totalTokens) }} tok · {{ fmtTimeIso(s.lastMs) }}
                </span>
              </button>
            </div>
            <div v-if="(chats?.sessions.length ?? 0) === 0" class="faint" style="padding: 12px">
              <template v-if="hasRetentionHint">
                No stored conversations. Enable <strong>Keep bodies</strong> on a capture-flagged setup (Serve → wizard) — past
                requests were captured without bodies, so nothing can be reconstructed for them.
              </template>
              <template v-else>No conversations in this range.</template>
            </div>
          </template>
        </div>
      </section>

      <!-- Conversation -->
      <section class="card">
        <div class="card__head">
          <h3 style="font-size: 15px">Conversation</h3>
          <span v-if="detail !== null" class="mono faint">{{ detail.models.join(", ") }} · {{ detail.requests }} requests</span>
        </div>
        <div class="card__body chat-body">
          <div v-if="selected === null" class="faint">Open a session to render what the model saw.</div>
          <div v-else-if="detailLoading" class="faint">Loading…</div>
          <p v-else-if="detailError !== null" class="faint" role="alert">{{ detailError }}</p>
          <template v-else-if="detail !== null">
            <p v-if="detail.compacted" class="chip chip--warn" style="display: inline-block">context compaction detected — earlier turns are missing by design</p>
            <div v-for="(turn, i) in detail.turns" :key="i" class="turn" :class="`turn--${turn.kind}`">
              <div class="turn__head">
                <span class="mono" style="font-size: 11px">{{ turnRole(turn) }}</span>
                <span v-if="turn.kind === 'message' && turn.toolResult !== null" class="faint mono" style="font-size: 11px">result for {{ turn.toolResult.callId.slice(0, 12) }}</span>
                <span v-if="turn.truncated" class="chip chip--muted">truncated</span>
              </div>
              <p v-if="turn.text !== null" class="turn__text">{{ turn.text }}</p>
              <div v-if="turn.imageUrls.length > 0" class="turn__images">
                <img v-for="(url, j) in turn.imageUrls" :key="j" :src="url" alt="attached image" class="turn__img" />
              </div>
              <details v-if="turn.toolCalls.length > 0" class="turn__tools">
                <summary class="mono" style="font-size: 12px">{{ turn.toolCalls.length }} tool call(s)</summary>
                <pre v-for="(call, j) in turn.toolCalls" :key="j" class="log" style="padding: 8px; font-size: 12px">{{ call.name }}({{ call.arguments }})</pre>
              </details>
            </div>
            <p class="faint mono" style="font-size: 11px; margin-top: 8px">
              renders exactly what the model saw · harness-side truncation is visible as such
            </p>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.chats-grid {
  grid-template-columns: minmax(300px, 380px) 1fr;
  align-items: start;
}
@media (max-width: 900px) {
  .chats-grid {
    grid-template-columns: 1fr;
  }
}
.chat-day + .chat-day {
  border-top: 1px solid var(--border);
}
.chat-row {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  border-left: 2px solid transparent;
  padding: 8px 12px;
  cursor: pointer;
  color: inherit;
}
.chat-row:hover {
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
}
.chat-row.is-active {
  border-left-color: var(--accent);
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
}
.chat-row__main {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 2px;
}
.chat-body {
  max-height: 72vh;
  overflow-y: auto;
}
.turn {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.turn--response {
  background: var(--surface-2, rgba(127, 127, 127, 0.06));
}
.turn--error {
  border-color: var(--error, #c0392b);
}
.turn--marker {
  border-style: dashed;
  opacity: 0.8;
}
.turn__head {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
}
.turn__text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
}
.turn__images {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.turn__img {
  max-width: 180px;
  max-height: 180px;
  border-radius: 6px;
  border: 1px solid var(--border);
}
.turn__tools {
  margin-top: 6px;
}
</style>
