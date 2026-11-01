import type { Directive } from "vue";

/**
 * Modal dialog behaviour (APG dialog pattern), companion to `v-scrim-close`:
 * - Escape closes (only while this dialog is the topmost one).
 * - Focus moves into the dialog on open (first focusable, else the panel).
 * - Tab / Shift+Tab cycle inside the dialog (simple focus trap).
 * - Focus is restored to the previously focused element on close.
 *
 * Usage: `v-dialog="closeFn"` on the PANEL element (the one with role="dialog").
 * A stack guards nested dialogs (drawer over board): Escape closes only the
 * topmost, and focus restore never steals from the dialog still open below.
 */
const stack: HTMLElement[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
  );
}

function trapTab(panel: HTMLElement, e: KeyboardEvent): void {
  const items = focusables(panel);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !panel.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

export const vDialog: Directive<HTMLElement, () => void> = {
  mounted(el, binding) {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    stack.push(el);
    const items = focusables(el);
    (items[0] ?? el).focus();
    const onKeydown = (e: KeyboardEvent): void => {
      if (stack[stack.length - 1] !== el) return; // topmost dialog only
      if (e.key === "Escape") {
        e.stopPropagation();
        binding.value();
        return;
      }
      // Tab handling only while focus lives inside this panel.
      if (e.key === "Tab" && el.contains(document.activeElement)) trapTab(el, e);
    };
    // Document-level: a click on non-focusable panel content parks focus on
    // body; a panel-level listener would never see Escape then.
    document.addEventListener("keydown", onKeydown, true);
    (el as HTMLElement & { __dialogCleanup?: () => void }).__dialogCleanup = () => {
      document.removeEventListener("keydown", onKeydown, true);
      const i = stack.indexOf(el);
      // Restore only when this was the topmost dialog — a dialog still open
      // underneath (or a dialog opened after) keeps focus.
      const wasTopmost = i >= 0 && i === stack.length - 1;
      if (i >= 0) stack.splice(i, 1);
      if (wasTopmost && previouslyFocused !== null && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  },
  unmounted(el) {
    (el as HTMLElement & { __dialogCleanup?: () => void }).__dialogCleanup?.();
  },
};
