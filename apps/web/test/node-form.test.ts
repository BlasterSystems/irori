import { describe, expect, it } from "vitest";
import type { NodeInfo } from "@irori/core";
import {
  emptyNodeForm,
  formFromNode,
  parsePorts,
  toCreatePayload,
  toPatchPayload,
  validateNodeForm,
  type NodeFormState,
} from "../src/node-form";

const NODE: NodeInfo = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "dgx1",
  kind: "spark",
  role: "head",
  host: "dgx1.example.com",
  enabled: true,
  agentVersion: "0.2.0",
  online: false,
  lastSeenAt: null,
  sortOrder: 0,
  llmPorts: [8080, 8081],
  nasRoot: null,
  cacheUser: null,
  createdAt: "2026-10-19T09:00:00.000Z",
  updatedAt: "2026-10-19T09:00:00.000Z",
};

describe("parsePorts", () => {
  it("parses comma/space separated positive ints, deduped, order kept", () => {
    expect(parsePorts("8080, 8081")).toEqual([8080, 8081]);
    expect(parsePorts(" 9090  8080")).toEqual([9090, 8080]);
    expect(parsePorts("8080,8080,9090")).toEqual([8080, 9090]);
  });

  it("drops junk, zero, negative and out-of-range entries", () => {
    expect(parsePorts("8080 x 9090")).toEqual([8080, 9090]);
    expect(parsePorts("0 -1 65536 65535")).toEqual([65535]);
    expect(parsePorts("")).toEqual([]);
  });
});

describe("validateNodeForm", () => {
  it("requires a name and a host", () => {
    expect(validateNodeForm(emptyNodeForm())).toBe("a name is required");
    const state = emptyNodeForm();
    state.name = "dgx1";
    expect(validateNodeForm(state)).toBe("a host or IP is required");
    state.host = "10.20.30.5";
    expect(validateNodeForm(state)).toBeNull();
  });
});

describe("toCreatePayload / toPatchPayload", () => {
  const state: NodeFormState = {
    name: "  dgx2 ",
    kind: "gpu-host",
    role: "standalone",
    host: " 10.20.30.79 ",
    ports: "8080, 8081, junk",
    nasRoot: " /mnt/nas ",
    cacheUser: " operator ",
  };

  it("trims fields, parses ports and nulls an empty nasRoot", () => {
    expect(toCreatePayload(state)).toEqual({
      name: "dgx2",
      kind: "gpu-host",
      role: "standalone",
      host: "10.20.30.79",
      llmPorts: [8080, 8081],
      nasRoot: "/mnt/nas",
      cacheUser: "operator",
    });
  });

  it("maps an empty nasRoot to null (clears the stored value)", () => {
    const cleared = { ...state, nasRoot: "" };
    expect(toPatchPayload(cleared)).toMatchObject({ nasRoot: null });
  });

  it("maps an empty cache user to null (clears the stored value, IR-101)", () => {
    const cleared = { ...state, cacheUser: "" };
    expect(toPatchPayload(cleared)).toMatchObject({ cacheUser: null });
  });
});

describe("formFromNode", () => {
  it("maps a NodeInfo onto editable strings", () => {
    const state = formFromNode(NODE);
    expect(state).toEqual({
      name: "dgx1",
      kind: "spark",
      role: "head",
      host: "dgx1.example.com",
      ports: "8080, 8081",
      nasRoot: "",
      cacheUser: "",
    });
    // Editing without touching fields must reproduce the stored ports.
    expect(toPatchPayload(state).llmPorts).toEqual([8080, 8081]);
  });
});
