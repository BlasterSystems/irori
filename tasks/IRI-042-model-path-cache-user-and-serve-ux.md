# Task: IRI-042 — MODEL_PATH resolution for cache users; wizard model list & scroll; hygiene clean CTA

## Objective

Make `MODEL_PATH` setups startable when the staged model lives in the node's **cache user** HF cache, fix the setup wizard's model-list truncation/scroll behavior, and make the disk-hygiene clean CTA always visible.

## Product manager summary

- **One-liner:** Cache-user-aware MODEL_PATH resolution plus three UI fixes (wizard scroll/truncation, model-choice clarity, hygiene CTA visibility).
- **User value:** Start of the `GLM-5.3-Flash-Abilt` cluster setup works without workarounds; the wizard is usable with large catalogs; the destructive clean action is discoverable and clearly gated.
- **Business impact:** Removes a blocking fleet-operation failure (serving down) and reduces support friction on the two most-used flows (serving setup, disk hygiene).
- **Success metric:** Owner starts the `GLM-5.3-Flash-Abilt` setup successfully; wizard reaches every catalog match; clean CTA visible without scrolling.
- **Dependencies & constraints:** None blocking. Modelctl is external state (ADR-0004); the per-user cache posture is ADR-0011; scripts are never edited.

## Acceptance criteria

- [ ] `SetupDriver` resolves `MODEL_PATH` through the node's cache user (runuser wrap, scrubbed env, per-user binary) when `cacheUser` is set and differs from the agent user; plain `execFile` otherwise — unit-tested both ways.
- [ ] When the cache user has no modelctl binary, start refuses with the actionable message (mirroring the push kind's `CommandBuildError` text), not a bare "resolution failed".
- [ ] The `GLM-5.3-Flash-Abilt` setup starts on the live fleet (model staged in operator's cache on DGX-1) and reaches `starting`/`running`.
- [ ] Wizard: model list is scrollable (capped height), more than 8 matches are reachable, the panel header/footer are sticky with body-only scroll, and each choice shows its repository as secondary text.
- [ ] Hygiene drawer: the typed-name confirm and `Clean N categories` button are visible without scrolling (sticky footer) on desktop and mobile; item counts pluralize.
- [ ] `pnpm test`, `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check` green.

## Scope

### Included

- `apps/agent/src/setups.ts` + `main.ts` + `modelctl.ts`: cache-user wrap for resolution, driver deps threading, shared wrap helper.
- `apps/web/src/components/ServeView.vue` (+ `assets/irori.css` if the sticky pattern promotes to shared CSS): wizard scroll restructure, model list scroll + cap raise + repository line.
- `apps/web/src/components/CleanupDrawer.vue`: sticky confirm/CTA footer, pluralization, long-path wrapping nit.
- Unit tests for the resolution wrap and any extracted pure helpers.

### Excluded

- Server-side staging/planner changes (behavior correct — the pre-check passed).
- modelctl changes (external repo).
- Chained-download `source` semantics for bare names (open item in the brief; separate follow-up if it proves broken).
- Engine script behavior; probe behavior.

## Plan

- [ ] Research: [docs/research/IRI-042-research-brief.md](../docs/research/IRI-042-research-brief.md) — root cause, options, evidence (2026-10-28).
- [ ] Agent: extract a reusable cache-user wrap helper from the push kind (`apps/agent/src/modelctl.ts`), add `cacheUser` + `resolveLocalUser` to `SetupDriver` deps, wire from `main.ts` (`transport.getCacheUser()`, `resolveLocalUser`), wrap `resolveModelPath`, log the wrapped command on failure, actionable error when the user's modelctl is missing.
- [ ] Agent tests: wrap/no-wrap argv building; missing per-user binary error path.
- [ ] Web: wizard layout — sticky header/footer, body-only scroll (reuse the `irori.css:326-327` pattern on desktop); model list `max-height` + `overflow-y: auto`; raise the `slice(0, 8)` cap; render `repository` under each choice label; keep `wizard.model` = catalog `name` (no semantic change).
- [ ] Web: CleanupDrawer sticky footer for confirm + `Clean N categories` (with the `N selected · bytes` summary), pluralized item counts, `overflow-wrap: anywhere` on long mono paths.
- [ ] Docs: CHANGELOG entry; note in `docs/` if the driver env contract changes (it does not — `$PORT`/`MODEL_PATH` contract unchanged).
- [ ] Validate: `pnpm test`, `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check`; live-verify the setup start on DEV.

## Architecture impact

- **ADR required:** No — implements the existing ADR-0011 cache-user posture for one more modelctl call site; no boundary/data/deployment change.
- **Relevant ADRs:** ADR-0004 (modelctl-owned store), ADR-0008 §7 (start env contract unchanged), ADR-0011 (per-user cache posture), IR-101 push precedent.
- **Proposed ADR:** None.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — passed; `.agentic/bin/docs-check` — no gaps (2026-10-28).
- Tests: full `pnpm test` — packages core 11 / proxy 4 / web 25 / agent 14 files green (db-gated suites skip by design). New: 3 `asCacheUser` builder tests (`apps/agent/test/m4.test.ts`), driver cache-user refusal test (`apps/agent/test/setups.test.ts`).
- Build: `pnpm build` — server (tsc), agent (esbuild bundle), web (vite) all green.
- Live smoke: on dgx1 the exact env-scrubbed resolution command the wrap execs returns the operator snapshot path (`/home/operator/.cache/huggingface/hub/models--Mia-AiLab--GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit/snapshots/57edefd2…`); `runuser` itself is fleet-proven by the push kind. End-to-end start of the real setup is owner-gated (would stop/start serving).
- Browser verify (vite dev + live hub data, 2026-10-28): wizard — header/footer pinned (measured pinned under overflow at 640px viewport), model list scrollable at 320px showing 25 of 148 matches with repository sub-lines; hygiene drawer on DGX-3 — `.hy-confirm` visible at drawer-open with `drawer.scrollTop === 0`, button `Clean 5 categories`, checkbox defaults exactly `HYGIENE_SAFE_CATEGORIES`, "1 item" pluralization rendering.

## Review

- Correctness: resolution must produce the identical path modelctl would print for the cache user (verified manually: `/home/operator/.cache/huggingface/hub/models--Mia-AiLab--GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit/snapshots/57edefd2…`).
- Security: wrap must keep the scrubbed env (`-u XDG_STATE_HOME -u HF_HOME -u HF_HUB_CACHE`, explicit `HOME`/`PATH`) so state never splits; no new token exposure.
- Compatibility: nodes without `cacheUser` keep the exact current behavior; older hubs/agents unaffected (agent-side change only).
- Residual risks: recipe scripts receiving a operator-owned path while running as root — root can read it; the recipe's own worker SSH already targets the same path shape. A cache user without modelctl now fails start with an actionable message (previously a confusing generic banner).
