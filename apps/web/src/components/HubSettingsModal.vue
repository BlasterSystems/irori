<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchHfTokenStatus, putHfToken } from "../api";

const emit = defineEmits<{ close: [] }>();

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
  <div class="backdrop" @click.self="!busy && emit('close')">
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

      <div class="card__head row--between">
        <span class="stat__sub">applies live — online agents get it immediately, others on reconnect</span>
        <div class="row">
          <button
            v-if="configured !== false"
            class="btn btn--danger btn--sm"
            :disabled="busy"
            @click="clear"
          >Clear token</button>
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
