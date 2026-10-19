<script setup lang="ts">
import { computed, ref } from "vue";
import type { NodeInfo } from "@irori/core";
import { live } from "../live";
import { createNode, patchNode, rotateNodeToken } from "../api";
import { copyToClipboard } from "../clipboard";
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

/** The WS URL the agent dials, derived from the page host. */
const agentWsUrl = computed(() =>
  typeof location === "undefined" ? "ws://<server>:3947/agent-ws" : `ws://${location.host}/agent-ws`,
);

const installLine = computed(() =>
  revealedToken.value === null ? "" : `./install-agent.sh --server ${agentWsUrl.value} --token ${revealedToken.value}`,
);

const envBlock = computed(() =>
  revealedToken.value === null ? "" : `IRORI_SERVER_URL=${agentWsUrl.value}\nIRORI_NODE_TOKEN=${revealedToken.value}`,
);

async function submit(): Promise<void> {
  if (busy.value) return;
  error.value = null;
  if (props.mode === "create") {
    const problem = validateNodeForm(form.value);
    if (problem !== null) {
      error.value = problem;
      return;
    }
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
  <div class="backdrop" @click.self="emit('close')">
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
          <div class="field" style="margin-bottom: 10px">
            <label>Agent token</label>
            <div class="row">
              <input class="input mono" :value="revealedToken" readonly />
              <button class="btn btn--secondary btn--sm" @click="copyToken">{{ copied ? "copied ✓" : "Copy" }}</button>
            </div>
          </div>
          <pre class="log" style="margin: 0 0 10px">{{ envBlock }}</pre>
          <p class="stat__sub">
            On the node, as root: <span class="mono">{{ installLine }}</span> — installs the bundle + root
            systemd unit and completes only when the WS hello lands. The card goes live on the first snapshot.
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
            <div class="field"><label>Name</label><input v-model="form.name" class="input" placeholder="dgx1" /></div>
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
              </div>
            </div>
            <div class="field"><label>Host / IP</label><input v-model="form.host" class="input mono" placeholder="10.20.30.5 or dgx1.example.com" /></div>
            <div class="field"><label>LLM probe ports (comma-separated)</label><input v-model="form.ports" class="input mono" placeholder="8080, 8081" /></div>
            <div class="field"><label>NAS store root (model-ops nodes)</label><input v-model="form.nasRoot" class="input mono" placeholder="/mnt/nas" /></div>
          </div>
        </template>
      </div>

      <div class="card__head row--between">
        <span class="stat__sub">
          {{ revealedToken !== null ? "" : mode === "rotate" ? "no traffic is interrupted until the agent reconnects" : "agent = privileged systemd service (install-agent.sh)" }}
        </span>
        <div class="row">
          <button class="btn btn--ghost btn--sm" @click="emit('close')">{{ revealedToken !== null ? "Done" : "Cancel" }}</button>
          <button v-if="revealedToken === null" class="btn btn--primary btn--sm" :disabled="busy" @click="submit">
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
