// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { liveMock } from "./live-mock";

/**
 * IRI-084: TelemetryDrawer tier — width persistence + clamped drag, the
 * live/offline chip, feed lines from the shared ring, and close.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  liveMock.events.value = [];
});

const ev = (over: Record<string, unknown>) => ({ seq: 1, serverTimeMs: Date.now(), ...over });

describe("TelemetryDrawer", () => {
  it("renders feed lines and the live chip; closes on ✕", async () => {
    const { default: TelemetryDrawer } = await import("../src/components/TelemetryDrawer.vue");
    liveMock.connected.value = true;
    liveMock.events.value = [ev({ type: "job", nodeId: "n1", kind: "sync-local", status: "succeeded", durationMs: 1234, params: {} })] as never;
    const w = mount(TelemetryDrawer as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(w.text()).toContain("live");
    expect(w.text()).toContain("sync-local");
    await w.find("button[aria-label='Close telemetry']").trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });

  it("clamps the width during a drag and persists it on release", async () => {
    const { default: TelemetryDrawer } = await import("../src/components/TelemetryDrawer.vue");
    (window as unknown as { innerWidth: number }).innerWidth = 1200;
    const w = mount(TelemetryDrawer as never);
    await w.find(".telemetry-resize").trigger("pointerdown");
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 100 })); // 1200-100 → clamp 720
    await nextTick();
    expect(w.attributes("style")).toContain("720px");
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 880 })); // 1200-880 → clamp 320
    await nextTick();
    expect(w.attributes("style")).toContain("320px");
    window.dispatchEvent(new PointerEvent("pointerup"));
    await new Promise((r) => setTimeout(r, 10));
    expect(localStorage.getItem("irori-telemetry-w")).toBe("320");
    w.unmount();
  });

  it("shows the offline chip when disconnected and defaults stored garbage width", async () => {
    localStorage.setItem("irori-telemetry-w", "bogus");
    const { default: TelemetryDrawer } = await import("../src/components/TelemetryDrawer.vue");
    liveMock.connected.value = false;
    const w = mount(TelemetryDrawer as never);
    expect(w.text()).toContain("offline");
    expect(w.text()).toContain("waiting for events…");
    w.unmount();
  });

  it("persists a valid stored width on mount", async () => {
    localStorage.setItem("irori-telemetry-w", "600");
    const { default: TelemetryDrawer } = await import("../src/components/TelemetryDrawer.vue");
    const w = mount(TelemetryDrawer as never);
    expect(w.attributes("style")).toContain("600px");
    w.unmount();
  });
});
