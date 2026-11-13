<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { live } from "../live";
import { feedLines } from "../overview";
import { fmtBucket } from "../analytics";

/** IRI-043: the fleet feed as an always-available right dock — the same ring
 *  the Overview card renders (IR-102), opened from the footer CTA. The left
 *  edge is draggable; width persists per browser. Sits at z 8 per the chrome
 *  layering contract: above the footer (5), below scrims (10)/topbar (20). */
const emit = defineEmits<{ close: [] }>();

const WIDTH_KEY = "irori-telemetry-w";
const WIDTH_MIN = 320;
const WIDTH_MAX = 720;
const width = ref(loadWidth());

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (Number.isFinite(n)) return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, n));
  } catch {
    /* storage unavailable — default width */
  }
  return 480;
}

let activeMove: ((e: PointerEvent) => void) | null = null;
let activeUp: (() => void) | null = null;

function startResize(ev: PointerEvent): void {
  ev.preventDefault();
  const move = (e: PointerEvent): void => {
    width.value = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, window.innerWidth - e.clientX));
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    activeMove = null;
    activeUp = null;
    try {
      localStorage.setItem(WIDTH_KEY, String(width.value));
    } catch {
      /* session-only width */
    }
  };
  activeMove = move;
  activeUp = up;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
onBeforeUnmount(() => {
  // A drag interrupted by unmount must not leave listeners behind.
  if (activeMove !== null) window.removeEventListener("pointermove", activeMove);
  if (activeUp !== null) window.removeEventListener("pointerup", activeUp);
});

const feed = computed(() =>
  feedLines(live.events.value, (id) => live.nodes.get(id)?.name ?? "node", 200, (jobId) => live.jobs.get(jobId)),
);

// IR-109 behavior: newest-last — keep the latest line in view. Watch the
// computed feed, not events.length: the ring caps at 300, past which the
// length stops changing while lines keep rotating.
const logEl = ref<HTMLElement | null>(null);
watch(feed, () => {
  void nextTick(() => {
    const el = logEl.value;
    if (el !== null) el.scrollTop = el.scrollHeight;
  });
});
</script>

<template>
  <aside class="telemetry-drawer" aria-label="Live telemetry" :style="{ width: `${width}px` }">
    <div class="telemetry-resize" aria-hidden="true" @pointerdown="startResize"></div>
    <div class="telemetry-head">
      <h3>Telemetry</h3>
      <span class="chip" :class="live.connected.value ? 'chip--ok' : 'chip--warn'">
        <span :class="live.connected.value ? 'pulse' : 'dot dot--warn'" aria-hidden="true"></span>
        {{ live.connected.value ? "live" : "offline" }}
      </span>
      <button class="iconbtn" aria-label="Close telemetry" @click="emit('close')">✕</button>
    </div>
    <div ref="logEl" class="telemetry-log">
      <div v-for="(line, i) in feed" :key="`${line.t}-${i}`"><span class="dim">{{ fmtBucket(line.t, "minute") }}</span> {{ line.text }}</div>
      <div v-if="feed.length === 0" class="faint">waiting for events…</div>
    </div>
  </aside>
</template>

<style scoped>
.telemetry-drawer {
  position: fixed;
  top: var(--topbar-h, 60px);
  right: 0;
  bottom: 0;
  z-index: 8;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: 1px solid var(--rule-2);
  border-radius: var(--radius-panel) 0 0 var(--radius-panel);
}
.telemetry-resize {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 7px;
  cursor: col-resize;
}
.telemetry-resize:hover {
  background: var(--grid);
}
.telemetry-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--rule);
}
.telemetry-head h3 {
  flex: 1;
  font-size: var(--fs-stat);
  font-weight: 600;
}
.telemetry-log {
  flex: 1;
  overflow: auto;
  padding: 10px 14px 16px;
  font-family: var(--font-mono);
  font-size: var(--fs-data-sm);
  line-height: 1.75;
  overflow-wrap: anywhere;
}
.telemetry-log .dim {
  color: var(--faint);
}
@media (max-width: 720px) {
  .telemetry-drawer {
    width: 100% !important; /* the inline width is a desktop affordance */
    border-left: 0;
  }
}
</style>
