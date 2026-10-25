<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchCadenceMs, fetchHfTokenStatus, putCadenceMs, putHfToken } from "../api";
import { serverCadenceMs } from "../version";
import { vScrimClose } from "../scrim";

const emit = defineEmits<{ close: [] }>();

/** Backdrop click closes only when the press started on the backdrop (scrim.ts). */
function onScrimClose(): void {
  if (!busy.value) emit("close");
}

/** IR-87: snapshot cadence in seconds (the setting is stored in ms). */
const cadenceSec = ref<number | null>(null);
const cadenceBusy = ref(false);
const cadenceError = ref<string | null>(null);
const cadenceOk = ref(false);

async function saveCadence(): Promise<void> {
  if (cadenceBusy.value || cadenceSec.value === null) return;
  const ms = Math.round(cadenceSec.value * 1000);
  cadenceBusy.value = true;
  cadenceError.value = null;
  try {
    await putCadenceMs(ms);
    serverCadenceMs.value = ms; // the footer reflects the change without a reload
    cadenceOk.value = true;
  } catch (err) {
    cadenceError.value = err instanceof Error ? err.message : String(err);
  } finally {
    cadenceBusy.value = false;
  }
}

/** null until the presence check lands; false/true render the field hint. */
const configured = ref<boolean | null>(null);
const token = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    configured.value = await fetchHfTokenStatus();
  } catch (err) {
    configured.value = null;
    // A submit already showing its own error must not be overwritten by the
    // slower presence check failing.
    if (!busy.value) error.value = err instanceof Error ? err.message : String(err);
  }
  try {
    const ms = await fetchCadenceMs();
    if (ms !== null) cadenceSec.value = Math.round(ms / 1000);
    cadenceOk.value = true;
  } catch {
    // Older hub without the route — leave the field empty and the save disabled.
  }
});

async function save(): Promise<void> {
  if (busy.value || token.value.trim() === "") return;
  await submit(token.value.trim());
}

async function clear(): Promise<void> {
  if (busy.value) return;
  await submit(null);
}

async function submit(value: string | null): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await putHfToken(value);
    emit("close");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="backdrop" v-scrim-close="onScrimClose">
    <div class="modal__panel" role="dialog" aria-modal="true" aria-label="Hub settings">
      <div class="card__head">
        <h3>Hub settings</h3>
        <button class="iconbtn" aria-label="Close" @click="emit('close')">✕</button>
      </div>

      <div class="card__body">
        <p v-if="error" class="banner banner--warn" style="margin-bottom: 10px">{{ error }}</p>

        <div class="stack" style="gap: 10px">
          <div class="field">
            <label>HF token (optional)</label>
            <input
              v-model="token"
              type="password"
              autocomplete="new-password"
              spellcheck="false"
              class="input mono"
              placeholder="hf_… — leave blank to keep the current value"
            />
          </div>
          <p class="stat__sub">
            Used for gated/private Hugging Face downloads and the quants listing. Stored on the hub and pushed to
            every agent's modelctl runs — never written into job params or logs.
            <template v-if="configured === true">A token is currently configured.</template>
            <template v-else-if="configured === false">No token is currently configured.</template>
          </p>
        </div>
      </div>

      <div class="card__head row--between" style="margin-top: 14px;">
        <h3 style="font-size: 15px;">Snapshot cadence</h3>
      </div>
      <div class="card__body" style="padding-top: 10px;">
        <p v-if="cadenceError" class="banner banner--warn" style="margin-bottom: 10px">{{ cadenceError }}</p>
        <div class="stack" style="gap: 10px">
          <div class="field">
            <label>Interval (seconds, 1–60)</label>
            <input v-model.number="cadenceSec" type="number" min="1" max="60" step="1" class="input" />
          </div>
          <p class="stat__sub">
            How often every agent samples hardware and LLM ports (default 2 s). Applies live — online agents pick it up
            without reconnecting<template v-if="cadenceOk">; the footer shows the active value</template>.
          </p>
        </div>
      </div>

      <div class="card__head row--between">
        <span class="stat__sub">applies live — online agents get it immediately, others on reconnect</span>
        <div class="row">
          <button
            v-if="configured !== false"
            class="btn btn--danger btn--sm"
            :disabled="busy"
            @click="clear"
          >Clear token</button>
          <button
            class="btn btn--secondary btn--sm"
            :disabled="cadenceBusy || cadenceSec === null || cadenceSec < 1 || cadenceSec > 60"
            @click="saveCadence"
          >{{ cadenceBusy ? "working…" : "Save cadence" }}</button>
          <button class="btn btn--ghost btn--sm" :disabled="busy" @click="emit('close')">Cancel</button>
          <button class="btn btn--primary btn--sm" :disabled="busy || token.trim() === ''" @click="save">
            {{ busy ? "working…" : "Save token" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--bg, #000) 55%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  padding: 16px;
}
.modal__panel {
  width: min(520px, 100%);
  max-height: 92vh;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius, 8px);
}
</style>
