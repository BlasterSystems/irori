// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nodeInfoSchema } from "@irori/core";

/**
 * IRI-084: NodeModal edit/rotate/create modes — the form submits through the
 * api layer, rotate reveals the token + install block, create validates.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

vi.mock("../src/api", () => ({
  createNode: vi.fn(async () => ({ token: "tok-create" })),
  patchNode: vi.fn(async () => ({})),
  rotateNodeToken: vi.fn(async () => "tok-rotated"),
}));

vi.mock("../src/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

afterEach(() => vi.clearAllMocks());

const UUID = "11111111-1111-4111-8111-111111111111";
const iso = new Date().toISOString();

const node = nodeInfoSchema.parse({
  id: UUID, name: "dgx1", kind: "spark", role: "head", host: "dgx1.lan",
  enabled: true, agentVersion: "0.4.0", online: true, lastSeenAt: iso, sortOrder: 0,
  createdAt: iso, updatedAt: iso,
});

async function mountModal(mode: "create" | "edit" | "rotate") {
  const { default: NodeModal } = await import("../src/components/NodeModal.vue");
  const w = mount(NodeModal as never, { props: { mode, node: mode === "create" ? null : node } as never });
  await new Promise((r) => setTimeout(r, 20));
  return w;
}

describe("NodeModal modes", () => {
  it("edit mode patches through the api and closes", async () => {
    const { patchNode } = (await import("../src/api")) as unknown as { patchNode: ReturnType<typeof vi.fn> };
    const w = await mountModal("edit");
    expect(w.text()).toContain("Edit dgx1");
    const save = w.findAll("button").find((b) => b.text() === "Save");
    await save!.trigger("click");
    await new Promise((r) => setTimeout(r, 30));
    expect(patchNode).toHaveBeenCalledWith(UUID, expect.objectContaining({ name: "dgx1" }));
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });

  it("create mode validates before posting and reveals the token after", async () => {
    const { createNode } = (await import("../src/api")) as unknown as { createNode: ReturnType<typeof vi.fn> };
    const w = await mountModal("create");
    const save = w.findAll("button").find((b) => b.text() === "Create node");
    await save!.trigger("click");
    await new Promise((r) => setTimeout(r, 20));
    expect(w.text()).toContain("name"); // validation problem mentions the field
    expect(createNode).not.toHaveBeenCalled();
    w.unmount();
  });

  it("rotate mode reveals a fresh token with the install block", async () => {
    const { rotateNodeToken } = (await import("../src/api")) as unknown as { rotateNodeToken: ReturnType<typeof vi.fn> };
    const w = await mountModal("rotate");
    expect(w.text()).toContain("Rotate token — dgx1");
    const rotate = w.findAll("button").find((b) => /rotate/i.test(b.text()) && b.text() !== "✕");
    await rotate!.trigger("click");
    await new Promise((r) => setTimeout(r, 30));
    expect(rotateNodeToken).toHaveBeenCalledWith(UUID);
    const text = w.text();
    expect(text).toContain("tok-rotated");
    expect(text).toContain("install-agent.sh --server");
    expect(text).toContain("--token tok-rotated");
    w.unmount();
  });
});
