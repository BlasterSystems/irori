// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { vDialog } from "../src/dialog";

/**
 * IRI-084: dialog directive contracts — APG behaviour: Escape closes the
 * topmost only, Tab/Shift+Tab wrap, focus is captured on open and restored
 * on unmount. Exercised through the directive hooks directly (the panels
 * are detached in mount tests; activeElement membership drives focusables).
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function panel(): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = "<button>one</button><button>two</button>";
  document.body.appendChild(el);
  return el;
}

function key(k: string, shift = false): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true });
}

describe("vDialog directive", () => {
  it("Escape closes the topmost dialog and stopPropagation", () => {
    const el = panel();
    const close = vi.fn();
    vDialog.mounted(el, { value: close } as never);
    const spy = vi.fn();
    document.addEventListener("keydown", spy, true);
    document.dispatchEvent(key("Escape"));
    expect(close).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1); // stopPropagation kept the capture-phase spy seeing it once
    vDialog.unmounted(el);
    document.removeEventListener("keydown", spy, true);
  });

  it("a non-topmost dialog ignores Escape; the topmost still closes", () => {
    const first = panel();
    const second = panel();
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    vDialog.mounted(first, { value: closeFirst } as never);
    vDialog.mounted(second, { value: closeSecond } as never);
    document.dispatchEvent(key("Escape"));
    expect(closeSecond).toHaveBeenCalledTimes(1);
    expect(closeFirst).not.toHaveBeenCalled();
    vDialog.unmounted(second);
    document.dispatchEvent(key("Escape"));
    expect(closeFirst).toHaveBeenCalledTimes(1); // now topmost again
    vDialog.unmounted(first);
  });

  it("Tab wraps from last to first and Shift+Tab from first to last", () => {
    const el = panel();
    const btns = el.querySelectorAll("button");
    for (const b of btns) Object.defineProperty(b, "offsetWidth", { value: 10 }); // happy-dom: make both count as visible
    vDialog.mounted(el, { value: vi.fn() } as never);
    btns[1]!.focus(); // becomes the activeElement → counted as focusable
    document.dispatchEvent(key("Tab"));
    expect(document.activeElement).toBe(btns[0]);
    btns[0]!.focus();
    document.dispatchEvent(key("Tab", true));
    expect(document.activeElement).toBe(btns[1]);
    vDialog.unmounted(el);
  });

  it("restores focus to the previously focused element on close", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const el = panel();
    vDialog.mounted(el, { value: vi.fn() } as never);
    expect(document.activeElement).not.toBe(outside); // captured into the dialog
    vDialog.unmounted(el);
    expect(document.activeElement).toBe(outside);
  });

  it("Tab with no focusable items preventDefaults instead of throwing", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    vDialog.mounted(el, { value: vi.fn() } as never);
    expect(() => document.dispatchEvent(key("Tab"))).not.toThrow();
    vDialog.unmounted(el);
  });
});
