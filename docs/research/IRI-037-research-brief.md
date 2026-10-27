# IRI-037 research brief — Node page: Sensors and Inference side by side

- **Date:** 2026-10-27
- **Ticket:** IRI-037 (story IR-111)
- **Goal:** The owner's DGX-1 screenshot shows the Sensors card and the :8081 inference panel each occupying half the row width but stacked on two rows, leaving the right half of the page empty. Question: what is the minimal structural change that puts them side by side without breaking multi-port nodes, the no-ports case, or the responsive collapse?

All questions are answerable from this repository; no external behavior is unknown.

## 1. Why do the two cards stack today?

`apps/web/src/components/NodeDetail.vue` (read 2026-10-27):

- `:547` `<h2 style="margin-bottom: 10px;">Live</h2>` → `:548` `<section class="cols cols-2" …>` containing **only** the Sensors `article.card` (`:549-564`). One grid item in a 2-column grid → half width, right cell empty.
- `:567` `<h2 …>Inference</h2>` → `:568` muted `p` when `llmPanels.length === 0` ("no LLM ports configured") → `:569-578` a **separate** `<section class="cols cols-2">` with the `LlmPanel` `v-for`.
- So both cards are already half-width (`.cols-2`), just marooned in two consecutive rows. The change is purely structural: no card resizes.

The panel count is unbounded: `llmPanels` (`:142-145`, IR-105) merges configured ports with detected-hot-added ones, so 0..n panels must keep working.

## 2. What layout machinery exists?

- `.cols { display: grid; gap: var(--space-3) }`, `.cols > * { min-width: 0 }`, `.cols-2 { grid-template-columns: repeat(2, 1fr) }` (`apps/web/src/assets/irori.css:91-98`). The `min-width: 0` rule is load-bearing for charts in cells (comment at `:92-93`).
- Collapse: `@media (max-width: 720px) { .cols-2, .cols-3, .cols-4 { grid-template-columns: 1fr; } }` (`:306`) — the merged row stacks back under 720px, matching today's mobile behavior.
- `LlmPanel.vue:19` root is a plain `<article class="card">` — no width assumptions; it already renders at half width today, so the merge changes nothing inside it. Vue scoped CSS applies parent styles to a child's root node, so a scoped gap rule in `NodeDetail.vue` can space stacked panels.
- `NodeDetail.vue:867` already has a `<style scoped>` block to host the rule.

## 3. Options

| Option | Structure | Tradeoff |
|---|---|---|
| **A: one merged `cols-2` section, two cells** | Cell 1: `h2 Live` + Sensors card. Cell 2: `h2 Inference` + `LlmPanel` v-for (stacked). Headings move into their cells. | Single source of truth for the row; multi-port panels stack under the Inference heading; no-ports case renders the muted text in the cell. Two wrapper `div`s. |
| B: flat 4-item grid (h2s as their own grid row) | `h2 Live, h2 Inference, Sensors, P1, P2…` auto-placed | With 2+ panels the extra panel lands in row 3 **left** column under Sensors, divorced from the Inference heading. |
| C: merge only when exactly one panel | Conditional layout | Two structures to maintain and test; behavior forks per port count. |

Option A chosen. Multi-port behavior changes from "panels side by side in their own row" to "panels stacked under the Inference heading" — accepted: each panel keeps today's half-width, the heading stays attached to its content, and the owner's fleet nodes are single-port (DGX-1 :8081 TensorFold). A 2-port node can revisit with a nested grid if it ever bothers anyone.

Spacing detail: multiple `LlmPanel`s in one cell need a vertical gap → scoped rule `.inference-cell > .card + .card { margin-top: var(--space-3); }` (scoped styles reach the child component root). The `inference history unavailable` note (`:579-583`) stays after the section.

## 4. Test impact (verified against the suites)

- `ds-markup.test.ts:89-93` pins `>Inference</h2>`, `no LLM ports configured`, `<LlmPanel`, `inference history unavailable` — all survive the merge; `:79` pins `cols-2` (still present).
- `chrome-markup.test.ts:20-49` pins the card rows/format props — untouched.
- New structural pin: the node page must have exactly one Live/Inference `cols-2` section (before the change there were two, plus History's at `:768` — total 3; after: 2).

## Summary of Findings

1. Both cards already render half-width in their own single-item `cols-2` rows (`NodeDetail.vue:548`, `:569`); the fix is merging them into one row.
2. Chosen: option A — one `cols-2` section with a Live cell (h2 + Sensors card) and an `inference-cell` (h2 + `LlmPanel` v-for + no-ports muted text); `.inference-cell > .card + .card { margin-top: var(--space-3) }` spaces stacked panels.
3. Responsive collapse (≤720px, iroiri.css:306) and all existing source pins survive; one new structural pin asserts the merged section.

Nothing remains open. Frontend-only (`apps/web`), no server/agent/core changes.
