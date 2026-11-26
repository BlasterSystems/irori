<script setup lang="ts">
import { computed, ref } from "vue";
import type { NodeInfo } from "@irori/core";
import { live } from "../live";
import { createNode, patchNode, rotateNodeToken } from "../api";
import { copyToClipboard } from "../clipboard";
import { vScrimClose } from "../scrim";
import { agentWsUrl as agentWsUrlFor, hubHttpBase } from "../agent-urls";
import {
  NODE_KIND_OPTIONS,
  NODE_ROLE_OPTIONS,
  emptyNodeForm,
  formFromNode,
  toCreatePayload,
  toPatchPayload,
  validateNodeForm,
  type NodeFormState,
} from "../node-form";

const props = defineProps<{
  /** create: POST + token reveal · edit: PATCH · rotate: confirm + token reveal */
  mode: "create" | "edit" | "rotate";
  node?: NodeInfo | null;
}>();

const emit = defineEmits<{ close: [] }>();

const form = ref<NodeFormState>(
  props.mode === "edit" && props.node ? formFromNode(props.node) : emptyNodeForm(),
);
const busy = ref(false);
const error = ref<string | null>(null);
/** One-time agent token after create/rotate; null = not revealed yet. */
const revealedToken = ref<string | null>(null);
const copied = ref(false);

const title = computed(() =>
  props.mode === "create"
    ? "Add node"
    : props.mode === "edit"
      ? `Edit ${props.node?.name ?? "node"}`
      : `Rotate token — ${props.node?.name ?? "node"}`,
);

const pageLocation = typeof location === "undefined" ? undefined : location;

/** The WS URL the agent dials, derived from the page (wss:// on https, IRI-156). */
const agentWsUrl = computed(() => agentWsUrlFor(pageLocation));

/** The hub's own HTTP root — the script, unit and bundle are served here. */
const httpBase = computed(() => hubHttpBase(pageLocation));

/** IRI-011: everything the node needs, fetched from the hub (no GitHub). */
const installBlock = computed(() =>
  revealedToken.value === null
    ? ""
    : [
        `curl -fsSL ${httpBase.value}/install-agent.sh -o install-agent.sh`,
        `curl -fsSL ${httpBase.value}/irori-agent.service -o irori-agent.service`,
        `sudo bash install-agent.sh --server ${agentWsUrl.value} --token ${revealedToken.value} --bundle-url ${httpBase.value}/agent/irori-agent.mjs`,
      ].join("\n"),
);

const installCopied = ref(false);

async function copyInstall(): Promise<void> {
  if (installBlock.value === "") return;
  installCopied.value = await copyToClipboard(installBlock.value);
}

const envBlock = computed(() =>
  revealedToken.value === null ? "" : `IRORI_SERVER_URL=${agentWsUrl.value}\nIRORI_NODE_TOKEN=${revealedToken.value}`,
);

async function submit(): Promise<void> {
  if (busy.value) return;
  error.value = null;
  if (props.mode === "create" || props.mode === "edit") {
    const problem = validateNodeForm(form.value);
    if (problem !== null) {
      error.value = problem;
      return;
    }
  } else if (props.node == null) {
    // Rotate with no node — the mount sites guard, but a silent no-op would
    // be worse than doing nothing at all.
    return;
  }
  busy.value = true;
  try {
    if (props.mode === "create") {
      const { token } = await createNode(toCreatePayload(form.value));
      revealedToken.value = token;
      await live.refreshNodes();
    } else if (props.mode === "edit" && props.node) {
      await patchNode(props.node.id, toPatchPayload(form.value));
      await live.refreshNodes();
      emit("close");
    } else if (props.mode === "rotate" && props.node) {
      revealedToken.value = await rotateNodeToken(props.node.id);
      await live.refreshNodes();
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function copyToken(): Promise<void> {
  if (revealedToken.value === null) return;
  copied.value = await copyToClipboard(revealedToken.value);
}
</script>

<template>
  <div class="backdrop" v-scrim-close="() => emit('close')">
    <div class="modal__panel" role="dialog" aria-modal="true" :aria-label="title">
      <div class="card__head">
        <h3>{{ title }}</h3>
        <button class="iconbtn" aria-label="Close" @click="emit('close')">✕</button>
      </div>

      <div class="card__body">
        <p v-if="error" class="banner banner--warn" style="margin-bottom: 10px">{{ error }}</p>

        <!-- One-time token reveal (create / rotate) -->
        <template v-if="revealedToken !== null">
          <p class="banner banner--warn" style="margin-bottom: 10px">
            {{ mode === "rotate"
              ? "Token rotated. The old token stops working at the agent's next reconnect — update /etc/irori/agent.env and restart irori-agent."
              : "Copy the token now — this is the only time it is shown." }}
          </p>
          <div class="bs-field bs-field--mono" style="margin-bottom: 10px">
            <label class="bs-field__label">Agent token</label>
            <div class="bs-field__box"><input class="bs-field__input" :value="revealedToken" readonly /></div>
            <div class="row"><button class="btn btn--secondary btn--sm" @click="copyToken">{{ copied ? "copied ✓" : "Copy" }}</button></div>
          </div>
          <pre class="log" style="margin: 0 0 10px">{{ envBlock }}</pre>
          <div class="field" style="margin-bottom: 10px">
            <label>Install on the node (as root) — everything is fetched from this hub</label>
            <pre class="log" style="margin: 0 0 6px">{{ installBlock }}</pre>
            <div class="row">
              <button class="btn btn--secondary btn--sm" @click="copyInstall">{{ installCopied ? "copied ✓" : "Copy" }}</button>
              <a class="btn btn--ghost btn--sm" href="/install-agent.sh" download>Download install-agent.sh</a>
            </div>
          </div>
          <p class="stat__sub">
            Installs the bundle (fetched via <span class="mono">--bundle-url</span>) + root systemd unit and completes only
            when the WS hello lands. The card goes live on the first snapshot. GitHub release artifacts remain a fallback
            (docs/DEPLOYMENT.md). After a token rotation: update <span class="mono">/etc/irori/agent.env</span> and restart — no live push.
          </p>
        </template>

        <!-- Rotate: confirm before the POST -->
        <template v-else-if="mode === 'rotate'">
          <p class="stat__sub" style="margin-bottom: 10px">
            Issues a new agent token for <strong>{{ node?.name }}</strong>. The current token keeps working until the
            agent's next reconnect — update <span class="mono">/etc/irori/agent.env</span> on the node and restart
            <span class="mono">irori-agent</span> afterwards. No live push exists (config-update carries no token).
          </p>
        </template>

        <!-- Create / edit form -->
        <template v-else>
          <div class="stack" style="gap: 10px">
            <div class="bs-field"><label class="bs-field__label">Name</label><div class="bs-field__box"><input v-model="form.name" class="bs-field__input" placeholder="dgx1" /></div></div>
            <div class="cols cols-2" style="gap: 10px">
              <div class="field"><label>Kind</label>
                <select v-model="form.kind" class="select">
                  <option v-for="k in NODE_KIND_OPTIONS" :key="k" :value="k">{{ k }}</option>
                </select>
              </div>
              <div class="field"><label>Role</label>
                <select v-model="form.role" class="select">
                  <option v-for="r in NODE_ROLE_OPTIONS" :key="r" :value="r">{{ r }}</option>
                </select>
                <p class="stat__sub">Auto-adjusted when serving setups change (head, worker, standalone). A manual choice persists until this node's membership changes.</p>
              </div>
            </div>
            <div class="bs-field bs-field--mono"><label class="bs-field__label">Host / IP</label><div class="bs-field__box"><input v-model="form.host" class="bs-field__input" placeholder="10.20.30.5 or dgx1.example.com" /></div></div>
            <div class="bs-field bs-field--mono"><label class="bs-field__label">LLM probe ports (comma-separated)</label><div class="bs-field__box"><input v-model="form.ports" class="bs-field__input" placeholder="8080, 8081" /></div></div>
            <div class="bs-field bs-field--mono"><label class="bs-field__label">NAS store root (model-ops nodes)</label><div class="bs-field__box"><input v-model="form.nasRoot" class="bs-field__input" placeholder="/mnt/nas" /></div></div>
            <div class="bs-field bs-field--mono">
              <label class="bs-field__label">Model cache user (optional)</label>
              <div class="bs-field__box"><input v-model="form.cacheUser" class="bs-field__input" placeholder="operator" /></div>
              <p class="stat__sub">Model transfers and serve engines run as this user; it needs its own modelctl and GPU access. Empty = the agent user (root).</p>
            </div>
            <div class="bs-field bs-field--mono">
              <label class="bs-field__label">Wake-on-LAN MAC (optional)</label>
              <div class="bs-field__box"><input v-model="form.wolMac" class="bs-field__input" placeholder="aa:bb:cc:dd:ee:ff" /></div>
              <p class="stat__sub">Enables the Wake action (magic packet to the node's /24 broadcast). Empty = cannot wake.</p>
            </div>
          </div>
        </template>
      </div>

      <div class="card__head row--between">
        <span class="stat__sub">
          {{ revealedToken !== null ? "" : mode === "rotate" ? "no traffic is interrupted until the agent reconnects" : "agent = privileged systemd service (install-agent.sh)" }}
        </span>
        <div class="row">
          <button class="btn btn--ghost btn--sm" @click="emit('close')">{{ revealedToken !== null ? "Done" : "Cancel" }}</button>
          <button v-if="revealedToken === null" class="btn btn--primary btn--sm" :disabled="busy || (mode !== 'create' && node == null)" @click="submit">
            {{ busy ? "working…" : mode === "create" ? "Create node" : mode === "edit" ? "Save" : "Rotate token" }}
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
  background: var(--overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
  padding: 16px;
}
.modal__panel {
  width: min(520px, 100%);
  max-height: 92vh;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--rule-2);
  border-radius: var(--radius-panel);
}
</style>
