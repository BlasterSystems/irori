import type { Directive } from "vue";

/**
 * Backdrop-close press guard. The browser fires `click` on the common
 * inclusive ancestor of the press and release points, so a press inside a
 * modal that releases over the backdrop (dragged selection, trackpad drift)
 * lands on the scrim element and a plain `@click.self` would close the modal
 * mid-interaction. Use `v-scrim-close="close"` on the backdrop element: it
 * closes only when the press itself started on the backdrop.
 */
const cleanup = new WeakMap<HTMLElement, () => void>();

export const vScrimClose: Directive<HTMLElement, () => void> = {
  mounted(el, binding) {
    let pressedOnScrim = false;
    const down = (e: Event): void => {
      pressedOnScrim = e.target === el;
    };
    const click = (e: Event): void => {
      if (pressedOnScrim && e.target === el) binding.value();
    };
    el.addEventListener("mousedown", down, true);
    el.addEventListener("click", click);
    cleanup.set(el, () => {
      el.removeEventListener("mousedown", down, true);
      el.removeEventListener("click", click);
    });
  },
  unmounted(el) {
    cleanup.get(el)?.();
    cleanup.delete(el);
  },
};
