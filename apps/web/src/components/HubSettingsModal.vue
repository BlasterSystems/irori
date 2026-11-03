<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchCadenceMs, fetchEnergyCost, fetchHfTokenStatus, fetchTokenCost, putCadenceMs, putEnergyCost, putHfToken, putTokenCost } from "../api";
import { serverCadenceMs } from "../version";
import { auditDomainHash } from "../audit-data";
import { energyCost, tokenCost } from "../cost-settings";
import { CURRENCIES, type Currency, type EnergyCost, type TokenCost } from "@irori/core";
import { vScrimClose } from "../scrim";

const emit = defineEmits<{ close: [] }>();

/** Backdrop click closes only when the press started on the backdrop (scrim.ts). */
function onScrimClose(): void {
  emit("close");
}

// ─── HF token ───────────────────────────────────────────────────────────────

/** null until the presence check lands; false/true render the field hint. */
const configured = ref<boolean | null>(null);
const token = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const tokenOk = ref(false);

async function submitToken(value: string | null): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await putHfToken(value);
    configured.value = value !== null;
    token.value = "";
    tokenOk.value = true;
    setTimeout(() => (tokenOk.value = false), 2000);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

// ─── Snapshot cadence ───────────────────────────────────────────────────────

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

// ─── Energy + token cost (IRI-025, one shared currency) ─────────────────────

const currency = ref<Currency>("EUR");
const energyPrice = ref<string>("");
const tokenInputPrice = ref<string>("");
const tokenCachedPrice = ref<string>("");
const tokenOutputPrice = ref<string>("");
const energyBusy = ref(false);
const tokenBusy = ref(false);
const energyError = ref<string | null>(null);
const tokenError = ref<string | null>(null);
const energyOk = ref(false);
const tokenCostOk = ref(false);

function parsePrice(raw: string, min: number, max: number): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > min && n <= max ? n : null;
}

const energyPriceValue = computed(() => parsePrice(energyPrice.value, 0, 100));
const tokenInputValue = computed(() => parsePrice(tokenInputPrice.value, -1, 1000));
const tokenCachedValue = computed(() => parsePrice(tokenCachedPrice.value, -1, 1000));
const tokenOutputValue = computed(() => parsePrice(tokenOutputPrice.value, -1, 1000));
const tokenPricesValid = computed(
  () => tokenInputValue.value !== null && tokenCachedValue.value !== null && tokenOutputValue.value !== null,
);

async function saveEnergy(): Promise<void> {
  if (energyBusy.value || energyPriceValue.value === null) return;
  energyBusy.value = true;
  energyError.value = null;
  try {
    const next: EnergyCost = { pricePerKwh: energyPriceValue.value, currency: currency.value };
    await putEnergyCost(next);
    energyCost.value = next;
    energyOk.value = true;
    setTimeout(() => (energyOk.value = false), 2000);
  } catch (err) {
    energyError.value = err instanceof Error ? err.message : String(err);
  } finally {
    energyBusy.value = false;
  }
}

async function saveTokenCost(): Promise<void> {
  if (tokenBusy.value || !tokenPricesValid.value) return;
  tokenBusy.value = true;
  tokenError.value = null;
  try {
    const next: TokenCost = {
      input: tokenInputValue.value!,
      cached: tokenCachedValue.value!,
      output: tokenOutputValue.value!,
      currency: currency.value,
    };
    await putTokenCost(next);
    tokenCost.value = next;
    tokenCostOk.value = true;
    setTimeout(() => (tokenCostOk.value = false), 2000);
  } catch (err) {
    tokenError.value = err instanceof Error ? err.message : String(err);
  } finally {
    tokenBusy.value = false;
  }
}

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
  try {
    const energy = await fetchEnergyCost();
    if (energy !== null) {
      energyPrice.value = String(energy.pricePerKwh);
      currency.value = energy.currency;
    }
  } catch {
    // Older hub — sections stay empty until saved.
  }
  try {
    const tok = await fetchTokenCost();
    if (tok !== null) {
      tokenInputPrice.value = String(tok.input);
      tokenCachedPrice.value = String(tok.cached);
      tokenOutputPrice.value = String(tok.output);
      currency.value = tok.currency;
    }
  } catch {
    // Older hub — sections stay empty until saved.
  }
});
</script>

<template>
  <div class="backdrop" v-scrim-close="onScrimClose">
    <div class="modal__panel" role="dialog" aria-modal="true" aria-label="Hub settings">
      <div class="card__head">
        <h3>Hub settings</h3>
        <span class="row" style="gap: 8px">
          <a class="btn btn--ghost btn--sm" :href="auditDomainHash('settings')" title="Audited settings changes" @click="emit('close')">Audit</a>
          <button class="iconbtn" aria-label="Close" @click="emit('close')">✕</button>
        </span>
      </div>

      <div class="modal__grid">
        <section class="setsec">
          <h4>HF token <span class="faint">(optional)</span></h4>
          <p v-if="error" class="banner banner--warn" style="margin-bottom: 8px">{{ error }}</p>
          <div class="field">
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
          <div class="row" style="margin-top: 10px">
            <button class="btn btn--secondary btn--sm" :disabled="busy || token.trim() === ''" @click="submitToken(token.trim())">
              {{ busy ? "working…" : tokenOk ? "saved" : "Save token" }}
            </button>
            <button v-if="configured !== false" class="btn btn--danger btn--sm" :disabled="busy" @click="submitToken(null)">Clear token</button>
          </div>
        </section>

        <section class="setsec">
          <h4>Snapshot cadence</h4>
          <p v-if="cadenceError" class="banner banner--warn" style="margin-bottom: 8px">{{ cadenceError }}</p>
          <div class="field">
            <input v-model.number="cadenceSec" type="number" min="1" max="60" step="1" class="input" />
          </div>
          <p class="stat__sub">
            How often every agent samples hardware and LLM ports (default 2 s). Applies live — online agents pick it
            up without reconnecting<template v-if="cadenceOk">; the footer shows the active value</template>.
          </p>
          <div class="row" style="margin-top: 10px">
            <button
              class="btn btn--secondary btn--sm"
              :disabled="cadenceBusy || cadenceSec === null || cadenceSec < 1 || cadenceSec > 60"
              @click="saveCadence"
            >{{ cadenceBusy ? "working…" : "Save cadence" }}</button>
          </div>
        </section>

        <section class="setsec">
          <h4>Energy cost</h4>
          <p v-if="energyError" class="banner banner--warn" style="margin-bottom: 8px">{{ energyError }}</p>
          <div class="row" style="align-items: flex-end; gap: 10px">
            <div class="field" style="flex: 1">
              <label>Price per kWh</label>
              <input v-model="energyPrice" type="number" min="0" max="100" step="0.01" class="input mono" inputmode="decimal" />
            </div>
            <div class="field" style="width: 110px">
              <label>Currency</label>
              <select v-model="currency" class="select">
                <option v-for="c in CURRENCIES" :key="c" :value="c">{{ c }}</option>
              </select>
            </div>
          </div>
          <p class="stat__sub">Used for the Overview power cost estimate over the selected range. Fleet-only — the NAS is excluded.</p>
          <div class="row" style="margin-top: 10px">
            <button class="btn btn--secondary btn--sm" :disabled="energyBusy || energyPriceValue === null" @click="saveEnergy">
              {{ energyBusy ? "working…" : energyOk ? "saved" : "Save cost" }}
            </button>
          </div>
        </section>

        <section class="setsec">
          <h4>Token cost</h4>
          <p v-if="tokenError" class="banner banner--warn" style="margin-bottom: 8px">{{ tokenError }}</p>
          <div class="row" style="align-items: flex-end; gap: 10px">
            <div class="field" style="flex: 1">
              <label>Input</label>
              <input v-model="tokenInputPrice" type="number" min="0" max="1000" step="0.001" class="input mono" inputmode="decimal" />
            </div>
            <div class="field" style="flex: 1">
              <label>Cached</label>
              <input v-model="tokenCachedPrice" type="number" min="0" max="1000" step="0.001" class="input mono" inputmode="decimal" />
            </div>
            <div class="field" style="flex: 1">
              <label>Output</label>
              <input v-model="tokenOutputPrice" type="number" min="0" max="1000" step="0.001" class="input mono" inputmode="decimal" />
            </div>
            <div class="field" style="width: 110px">
              <label>Currency</label>
              <select v-model="currency" class="select">
                <option v-for="c in CURRENCIES" :key="c" :value="c">{{ c }}</option>
              </select>
            </div>
          </div>
          <p class="stat__sub">Per-million-token prices for the token cost preview on the Overview (NAS section).</p>
          <div class="row" style="margin-top: 10px">
            <button class="btn btn--secondary btn--sm" :disabled="tokenBusy || !tokenPricesValid" @click="saveTokenCost">
              {{ tokenBusy ? "working…" : tokenCostOk ? "saved" : "Save prices" }}
            </button>
          </div>
        </section>

        <div class="setsec setsec--foot row row--between">
          <span class="stat__sub">changes apply immediately — no restart</span>
          <button class="btn btn--ghost btn--sm" @click="emit('close')">Close</button>
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
  width: min(880px, 100%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius, 8px);
}
/* Scroll-free 2x2 layout: four self-contained sections + a shared footer row. */
.modal__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.setsec {
  padding: 14px 20px 16px;
  border-top: 1px solid var(--border);
}
.setsec:nth-child(-n + 2) {
  border-top: 0;
}
.setsec--foot {
  grid-column: 1 / -1;
  padding-block: 10px;
}
.setsec h4 {
  font-size: 13px;
  margin: 0 0 8px;
}
@media (max-width: 720px) {
  .modal__grid {
    grid-template-columns: 1fr;
  }
  .setsec:nth-child(2) {
    border-top: 1px solid var(--border);
  }
  .modal__panel {
    max-height: 92vh;
    overflow: auto;
  }
}
</style>
