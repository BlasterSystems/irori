# IRI-053 — Serve status demotion and serve-page UX research brief

Date: 2026-10-31 · Hub: dev-0.4.0-1 (10.20.30.9:3947) · Repo: main (v0.4.0)
Sources: live API probes (2026-10-31 22:21–22:32Z), driven-browser screenshots, three parallel investigations (bug trace, UI/UX expert review, PM review). Findings cross-checked and consistent.

## Part A — Bug: a running engine is demoted to `stopped` and cannot be stopped

**Owner report:** "when I start a model on irori, after it starts and I refresh the page it looses current status and I cannot stop."

**Root cause:** the TensorFold recipe daemonizes the engine (`docker run -d`) and its start script exits 0 after a readiness wait. The agent's driver-truth poll sees a dead process group and reports `stopped`; the hub demotes the row and, by explicit design, "polls never promote via the probe" — so a live engine stays `stopped` forever. Refresh is incidental: the hub lost the status 1.6 s after start.

### Mechanism chain (file:line)

1. `POST /setups/:id/start` → hub writes `starting/health:starting` on agent ack — `apps/server/src/setups-service.ts:570`. Agent spawns start.sh detached in its own group — `apps/agent/src/setups.ts:352-374`.
2. Recipe: `docker run -d` both ranks (engines live in docker's cgroup, not the script's pgid), poll `$URL/v1/models` until ready, **exit 0** (`~/developer/recipes/GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold/start.sh`; only `FOREGROUND=1` stays attached).
3. Script exit 0 → agent emits `{state:"stopped", exitCode:0}` and **retains the driver record** (scriptStop, pgid) so stop can still reach the engine — `apps/agent/src/setups.ts:415-431`.
4. Probe promotes: engine answers :8081, model matches → `running/healthy` — `setups-service.ts:401-403` or exit-0 promotion `:681-690`. Live event: 21:59:05.808.
5. Driver-truth poll (every 15 s: `SETUPS_TICK_MS=5000` × `DRIVER_POLL_EVERY=3`, `apps/server/src/index.ts:72`, `setups-service.ts:94, 743-744`) → agent `reportStatus` computes `alive = child-running || groupAlive(pgid)` = false → `{state:"stopped", exitCode:null}` (`apps/agent/src/setups.ts:563-585`). Hub demotes: `status="stopped", health=null` — `setups-service.ts:691-696`. Live event: 21:59:07.406.
6. Permanent: `tick()` runs `evaluateHealth` only for rows already `starting|running` — `setups-service.ts:738-741`. A `stopped` row with a serving engine is never re-probed.
7. Triple-locked out of stopping:
   - UI renders Stop only for `starting|running` (removed from DOM, not disabled) — `apps/web/src/components/ServeView.vue:698-701`;
   - hub `stop()` early-returns a silent no-op when `row.status === "stopped"` — `setups-service.ts:579`;
   - ServeView polls `GET /setups` every 2.5 s (`ServeView.vue:92-102`) and does not consume `setup-state` SSE (`apps/web/src/live.ts:215-218` — feed only), so REST truth always wins after refresh.
8. Re-Start loops: start guard passes (group dead), recipe detects `all_running` → exit 0 → probe promotes → next poll demotes. Owner sees a ~15 s healthy flicker.

Disproven hypothesis: model-string mismatch. `modelIdMatches` is a bidirectional substring match (`packages/core/src/setups.ts:191-197`); `"GLM-5.3-Flash-EXL3" ⊂ "GLM-5.3-Flash-EXL3-4bpw-TensorFold"` matches.

### Live evidence (2026-10-31)

- `GET /api/v1/setups`: row `474c2800` GLM-Flash-TP2-MIIA (head DGX-1, worker DGX-2, port 8081): `status stopped`, `health null`, `lastError null`, `lastStartedAt 21:55:28.168Z`, `updatedAt 21:59:07.402Z`.
- `GET /api/v1/events/recent`: `starting` 21:55:28 → `running/healthy` **21:59:05.808** → `stopped/null` **21:59:07.406** (1.6 s later; no agent restart involved — agent-update finished 21:47).
- `GET /api/v1/nodes/7a575210…/llm` (DGX-1) 22:23–22:32: port 8081 `detected:true, backend tensorfold, model "GLM-5.3-Flash-EXL3"`, 3–4 decoding streams, decodeTps 35→87, kvCache 36–54 % — **the engine is serving right now while the hub says stopped**.
- Overview hero already labels this engine `tensorfold:8081 · DGX-1 · unmanaged` (`OverviewView.vue:411-419`) — the two pages contradict each other.
- Corrupt row 69916930 (IRI-023) is gone (owner deleted it); unrelated to this bug. Three 21:52–21:55 frames `start script is not executable: ~/developer/...` — tilde paths fail the agent's `test -x`; saved row `a10d0499` still carries a dead tilde path.

### Repro conditions

Any recipe that (a) launches the engine detached (`docker run -d`, `setsid`, `nohup … &`) and (b) exits 0 after a readiness wait. Within ≤15 s of script exit the row flips `running/healthy → stopped`; blocking recipes (`FOREGROUND=1`) are immune.

### Fix options (ranked)

1. **Probe-truth override in `onDriverEvent` (server-only, root cause, ~10 lines)** — on a poll-reported `stopped` (`exitCode === null`), consult `latestPortSnap(headNodeId, port)`: if `detected && modelIdMatches` → keep/restore `running/healthy` (or `foreign` when detected-but-mismatched) instead of demoting; optionally let `evaluateHealth` examine `stopped` rows (drop the `:739` gate). The probe is already the documented source of truth for health (`packages/core/src/setups.ts:16-17`); the driver pgid is not a valid liveness signal for daemonized engines.
2. **Stop escape hatch (server + web)** — drop/relax the `stop()` early return (`setups-service.ts:579`): forward `setup-stop` regardless of status (the agent answers harmlessly when nothing runs; with a retained record it runs stop.sh and actually kills the docker ranks). Render Stop for `stopped` rows when an engine is detectable/`lastStartedAt` recent.
3. **Agent-side liveness for retained records** — `reportStatus` verifies the engine itself (TCP probe of the setup port or docker inspect) instead of pgid-only. Heavier; agent rollout; needed only if the hub must distinguish "engine alive" from "something else answers the port".
4. **Contract/docs** — document that recipes must block (`FOREGROUND=1`) or wait for fix 1. Mitigation only.

## Part B — UI/UX expert review of the Serve page

Reviewed against OverviewView/ModelsView and iorbi.css tokens (`apps/web/src/assets/irori.css`), live screenshots of list, all 5 wizard steps, drawer, small tier. Already fixed in current code (do not re-file): `in`-operator worker bug (now `.includes`, `ServeView.vue:783`), NAS-as-worker filter, wizard port round-trip (IRI-051), MODEL_PATH start-refusal recovery (IR-76). Keep: armed stop/remove double-click guard, honest `foreign` subline, review env chips, scrim press-guard.

| # | Sev | Finding | Evidence | Recommendation |
|---|-----|---------|----------|----------------|
| B1 | P1 | Stopped/failed cards show live-state chips: a stopped cluster renders green "JOINED" workers | `setupNodeLines` (`apps/web/src/serve.ts:295-333`) uses node online + probe only, ignores `setup.status`; rendered `ServeView.vue:707-709` | Gate node-line copy on setup status; idle chips for stopped/failed |
| B2 | P2 | `failed` visually identical to `stopped` | `setupChipCls` maps both to `chip--halt` (`serve.ts:203-216`) | `failed` → `chip--warn`; keep lastError subline; surface lastError in drawer header |
| B3 | P2 | Wizard placement rows show raw verbs ("push"/"sync"); Models page already shows state-shaped copy | `ServeView.vue:844-848` vs `placementChip` (`apps/web/src/models.ts:471-485`) | Reuse `placementChip(row.action)` in the wizard |
| B4 | P2 | 8th worker click silently ignored | `:change="… length < 7 && push"` (`ServeView.vue:783-785`) | Disable unchecked workers at cap + inline hint "cluster capped at 8 nodes (head + 7 workers)" |
| B5 | P2 | Dialogs not escapable/focus-contained | `v-scrim-close` handles backdrop press only; drawer lacks `aria-modal` (`:714`); wizard has it (`:774`) | Extend directive: Escape, initial focus, trap, restore; `aria-modal` on drawer |
| B6 | P2 | Start/Stop/Remove have no in-flight state | `onStart/onStop/onRemove` (`:104-113, 131-139, 199-208`) disable nothing | Per-action busy ref; label "Starting…"/"Stopping…" until load() returns |
| B7 | P3 | Detail drawer has no Start/Stop | drawer actions Edit/Duplicate/Remove only (`:756-758`) | Start/Stop in drawer header next to the state chip |
| B8 | P3 | Stale/garbled placement copy | `:885` quotes a removed button; `:871` not a sentence; `:815` wrong after IRI-051 | Rewrite sublines; delete quoted-button line |
| B9 | P3 | Implementation leaks in labels | "Validate on head (test -x)" `:833`; "armed stop is a core promise" `:830`; "timeout 15 m" `:903` | Plain operator copy; drop/move the timeout aside |
| B10 | P3 | Review header "Runs" mislabels a configuration summary | `:889-897` | Rename to "Configuration" |
| B11 | P3 | Wizard error banner renders below the sticky footer, far from fields | `:938`, measured live (y 758-800 vs footer ~710) | Sticky banner above footer + field-level messages |
| B12 | P3 | Input focus uses the danger token | `.input:focus { border-color: var(--thread) }` (`irori.css:259`) — same red as `.btn--danger` | Focus ring on `--ink`/`--border-strong`; reserve `--thread` for danger |
| B13 | P3 | "Engine log · streaming into telemetry" is currently false; unexplained "no output yet" | `:746`; IR-147 pending | "Engine log (live while running)"; empty state explains |
| B14 | P3 | No summary line; list order ignores state | pagehead `:671-680`; list renders API order `:687` | "1 running · 3 stopped" mono summary; stable-sort running→failed→stopped |
| B15 | P3 | Minor: port shown twice per card; step dots not clickable; faint empty state; naming mix ("Scripts" step vs "Recipe folder" field; "Stage transfers" vs "Download") | various | Copy sweep; pick one verb per concept |

Target structure (expert proposal): pagehead summary → **Running** section (status-accurate chips, Stop/Logs, transfer bars) → **Not running** section (failed styled warn, last error) → detail drawer with Start/Stop in header → wizard kept (5 steps) with cap-aware workers, placementChip, sticky error banner.

## Part C — PM review

Journey breaks: Start (status false seconds after launch), Monitor (Serve says stopped / Overview says unmanaged engine), Stop (button hidden, API no-ops, fallback kills a dead group). Naming: `stopped` chip covers three realities (never started / stopped on purpose / orphaned but serving) — split the vocabulary; `foreign` → "wrong engine"; "recipe folder" → "scripts folder". Structure: manage-list + drawer is right; the missing piece is a **truth layer**: a probe-derived "Running now" section (managed + unmanaged with Adopt) sourced like the Overview hero, plus start pre-flight (IRI-023 §9 owner decision still open) and pre-save script validation with `~` expansion.

Prioritized: P0.1 probe-vs-driver reconciliation (= Part A fix 1) · P0.2 stop always reachable (= fix 2) · P0.3 agent stop must reach detached engines (= fix 3) · P1.1 "Running now" section · P1.2 start pre-flight · P1.3 enforce script validation before save + expand/reject `~` paths · P1.4 split `stopped` vocabulary · P2.1 ServeView consumes `setup-state` SSE · P2.2 copy sweep + model id on card · P2.3 agent start guard considers probe state (no duplicate engine spawn).

## Ticket map

- **IR-151 (Bug, High)** — Part A: status demotion + unstoppable engine; fix options 1+2 (3 optional follow-up).
- **IR-152 (Task, Medium)** — Parts B+C: serve-page UX overhaul; stories splittable on owner approval.
