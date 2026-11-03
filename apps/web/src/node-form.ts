import { NODE_KINDS, NODE_ROLES, type NodeCreatePayload, type NodeInfo, type NodePatchPayload } from "@irori/core";

/** Kind/role options for the modal selects, straight from the core enums. */
export const NODE_KIND_OPTIONS: readonly string[] = NODE_KINDS;
export const NODE_ROLE_OPTIONS: readonly string[] = NODE_ROLES;

/** Editable form state — ports/nasRoot/cacheUser stay strings until submit;
 *  kind/role are strings so <select v-model> typechecks (values come from the
 *  enums). */
export interface NodeFormState {
  name: string;
  kind: string;
  role: string;
  host: string;
  ports: string;
  nasRoot: string;
  cacheUser: string;
  /** IRI-068: Wake-on-LAN MAC (aa:bb:cc:dd:ee:ff); empty = cannot wake. */
  wolMac: string;
}

export function emptyNodeForm(): NodeFormState {
  return { name: "", kind: "spark", role: "standalone", host: "", ports: "", nasRoot: "", cacheUser: "", wolMac: "" };
}

export function formFromNode(node: NodeInfo): NodeFormState {
  return {
    name: node.name,
    kind: node.kind,
    role: node.role,
    host: node.host,
    ports: node.llmPorts.join(", "),
    nasRoot: node.nasRoot ?? "",
    cacheUser: node.cacheUser ?? "",
    wolMac: node.wolMac ?? "",
  };
}

/** Parse a comma/space-separated port list: positive ints, deduped, order kept. */
export function parsePorts(raw: string): number[] {
  const out: number[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    if (part === "") continue;
    const n = Number(part);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** First validation problem, or null when the form can be submitted. */
export function validateNodeForm(state: NodeFormState): string | null {
  if (state.name.trim() === "") return "a name is required";
  if (state.host.trim() === "") return "a host or IP is required";
  return null;
}

export function toCreatePayload(state: NodeFormState): NodeCreatePayload {
  return {
    name: state.name.trim(),
    // The selects are populated from NODE_KINDS/NODE_ROLES; the server
    // re-validates with nodeCreateSchema either way.
    kind: state.kind as NodeCreatePayload["kind"],
    role: state.role as NodeCreatePayload["role"],
    host: state.host.trim(),
    llmPorts: parsePorts(state.ports),
    nasRoot: state.nasRoot.trim() === "" ? null : state.nasRoot.trim(),
    cacheUser: state.cacheUser.trim() === "" ? null : state.cacheUser.trim(),
    wolMac: state.wolMac.trim() === "" ? null : state.wolMac.trim().toLowerCase(),
  };
}

/** The edit form represents the node's full desired state, so every editable
 *  key is sent — the server applies exactly the keys present. */
export function toPatchPayload(state: NodeFormState): NodePatchPayload {
  return {
    name: state.name.trim(),
    kind: state.kind as NodePatchPayload["kind"],
    role: state.role as NodePatchPayload["role"],
    host: state.host.trim(),
    llmPorts: parsePorts(state.ports),
    nasRoot: state.nasRoot.trim() === "" ? null : state.nasRoot.trim(),
    cacheUser: state.cacheUser.trim() === "" ? null : state.cacheUser.trim(),
    wolMac: state.wolMac.trim() === "" ? null : state.wolMac.trim().toLowerCase(),
  };
}
