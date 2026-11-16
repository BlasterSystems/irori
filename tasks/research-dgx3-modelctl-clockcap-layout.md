# Research: DGX-3 node page — modelctl install refusal, clock-cap-drift false positive, main-content alignment

Date: 2026-11-16 · Repo: `main` @ `13c60b2` (prod hub runs `dev-0.7.0-24`) · Method: repo evidence (file:line) + live hub API probes (irori.lan, read-only) + two repo scouts.

## Jira target

- Project key **IR** · site **https://blastersystems.atlassian.net** · scrum board **5** · issuetype ids (createmeta, verified 2026-10-19): Epic `10021`, Story `10022`, Bug `10023`, Task `10024`, Subtask `10020`. Comments/descriptions: plain text, **no inline marks** (verified on IR-29).
- Active sprint: **live query blocked** — no blastersystems credential pair exists on this workstation (both local `.mcp.json` atlassian entries 401 against blastersystems). Last known: 1004 "IR Sprint 4" ended 2026-11-15; a past-end sprint still lists as `active` but **rejects adds** → must re-query the newest active sprint at creation time.
- Resolution path: repo config — `AGENTS.md` (IRI-`<n>` convention, task files in `tasks/`) — plus managed skills `irori-jira-ticket-filing` / `mwa-jira-rest` (Site 3). The user did not name a project in this conversation.
- Assignee: `<redacted-jira-account-id>` (Bruno Pires).

## Summary

Three observations from the DGX-3 node page, all root-caused:

1. **"Can't install modelctl on dgx3"** — the banner is truthful (`operator` has no per-user modelctl), but the Install button cannot fix it on dgx3 today: dgx3's agent bundle generation predates **IR-251**, whose fix ends a catch-22 where the install demanded the per-user binary it was supposed to create. The hub-served bundle already contains the fix; the node needs one **agent-update** (ops, no new code).
2. **"CLOCK CAP DRIFT: 281 ≥ 4 — STORED CAP NOT IN EFFECT ~141 MIN"** — the IR-189 health rule working as designed, **but with a structural false positive on GB10**: the driver rejects `clocks.applications.sm`, so the GPU read-back is permanently `null`, and `null ≠ stored 2200` is counted as drift on every 30 s sweep. Live probe: dgx3's CPU cap matches (2000 = 2000); the GPU side is merely *unmeasurable*. Every spark node with a stored GPU cap warns forever (all three do, in lockstep). One guard fixes it.
3. **"Main content not centered"** — **intentional**: DS v1.1 caps `.content` at 1360 px with no auto margins, byte-identical to the approved mockup and pinned verbatim by a contract test. The old pre-IR-217 shell centered (1200 px); IR-217 deliberately removed that. Re-centering is a new design decision (one property + mockup mirror + test pin), not a bug.

Net proposal: **1 Bug** (clock-cap false positive, shippable alone), **2 optional Tasks** (bundle-generation visibility; content centering — owner's design call), and **1 ops step** for dgx3 (agent-update + install) that needs explicit approval to execute. No epic warranted.

## Current state (evidence)

### Q1 — modelctl install on DGX-3

**The banner is the agent's own inventory truth.** `apps/agent/src/inventory.ts:330` pushes `{modelctlVersion: null, error: "modelctl is not installed for this user"}` when `localBinary(home)` finds no executable at `~/.local/bin/modelctl`, `/usr/local/bin/modelctl`, `/usr/bin/modelctl` (`inventory.ts:95-105`). The "0 models" is the error row's `models: []` — the cache was **never enumerated**, not proven empty.

**Fleet state (live, hub API `/api/v1/nodes/:id/models`, 2026-11-16 ~09:15Z):**

| Node | operator modelctl | error |
|---|---|---|
| DGX-1 | 0.24.0 | — |
| DGX-2 | 0.24.0 | — |
| DGX-3 | **null** | "modelctl is not installed for this user" |
| NAS | 0.24.0 | — |

Only DGX-3 is affected.

**Why the binary is missing:** an earlier install was misplaced by the node-level `UV_TOOL_BIN_DIR` redirect (IR-207: "a node-level `UV_TOOL_BIN_DIR` in the agent env silently redirected a root install into a cache user's bin (DGX-3, 2026-11-11), leaving the gate binary stale" — `apps/agent/src/modelctl.ts:296-300`).

**Why the button cannot repair it (the catch-22):** dgx3's agent was updated 2026-11-15T08:43:34Z (job `68c66233`, "update confirmed: agent reports 0.7.0") with a bundle generation that predates IR-251. Pre-IR-251, `modelctl-install {user}` resolved the executor via `resolveLocalUser`, which **requires the per-user binary the install exists to create** — "a guaranteed 'no modelctl for cache user …' failure for exactly the target case" (`apps/agent/src/modelctl.ts:270-274`; CHANGELOG.md:19-31, Unreleased; regression fixture literally *DGX-3 + operator + agentVersion 0.7.0*, `apps/web/test/node-detail-install-ir251.test.ts:6-11`).

**Live proof (hub API `/api/v1/jobs`):** five `modelctl-install` jobs on DGX-3 failed 2026-11-15 16:51→22:55 (`a04202c6`, `89d49690`, `c7b5f321`, `d5156d92`, `e970858b`) with the pre-IR-251 wording — *"error: modelctl-install: no modelctl for cache user \"operator\" — install it for that user (sudo -u operator uv tool install \"modelctl\") or clear the node's cache user setting"* — notably **without** the IR-247 suffix ("the hub auto-installs it after the next inventory read", `modelctl.ts:230-233`) that the fixed generation emits. The failures postdate the 08:43 update → the running process is a pre-fix generation. `agentVersion: 0.7.0` is semver-only and cannot reveal bundle generation (the documented "semver does NOT reflect the bundle generation" trap).

**The hub artifact already has the fix.** The served bundle `https://irori.lan/agent/irori-agent.mjs` (sha256 `269d6f65…f804cdc`, hub tag `dev-0.7.0-24`) contains the IR-251 marker string `no passwd entry for cache user` (×2) and the IR-247 wording (×1). The fixed install (`modelctl.ts:262-311`) resolves the passwd home only (`resolveCacheHome`, IRI-045), wraps `runuser -u operator`, exports `~/.local/bin` onto PATH, bootstraps uv via astral.sh if absent, gate-checks against the hub pin (`0.24.0`, `GET /api/v1/settings/modelctl-pin`), never downgrades, and pins `UV_TOOL_BIN_DIR` to the target home (IR-207).

**Also broken by the same stale bundle:** `autoProvisionModelctl` (IR-247, `apps/server/src/jobs-service.ts:103-127`) now converges `version: null` users after every succeeded `models-inventory` — it will keep dispatching installs that fail on dgx3 until the bundle is updated. UI no-op is **not** the issue here (the IR-251 `.value` guard fix is in the deployed web; jobs *were* created and failed).

**Agent-update safety:** no Irori-supervised setups exist on DGX-3 (`GET /api/v1/setups` returns none for the node); the hub 409-guards unsafe updates anyway; non-Irori docker engines on dgx3 (LEG-003 OCR eval) survive an agent restart.

### Q2 — "CLOCK CAP DRIFT: 281 ≥ 4 — STORED CAP NOT IN EFFECT ~141 MIN"

**Mechanism (IR-189).** The hub sweeps health every 30 s (`apps/server/src/index.ts:341-346`); for online nodes it calls `clockCaps.driftStreak(nodeId)` (`apps/server/src/health.ts:424-434`, wired `index.ts:303-304`). The rule (`packages/core/src/health.ts:126-129`): `clock_cap_drift`, op `gte`, seed threshold **4**, severity warn. `driftStreak` (`apps/server/src/clock-caps.ts:61-86,133-146`) compares the stored caps (DB `nodes` row: `gpuClockCapMHz` 2200 / `cpuClockCapMHz` 2000, both `persistent`, per live node row) against a live `clocks-get` from the agent. The badge renders the finding summary: value ≥ threshold + IR-254's humanized suffix `minutes = round(value × 30 s / 60)` (`apps/server/src/health.ts:118-129`) — so **281 = consecutive drifting 30 s sweeps**, 4 = threshold, 141 min = 281 × 30 s. The streak is an **in-memory Map** (`clock-caps.ts:90,133-146`): it resets on hub restart, node offline, or unreadable reading — `~N min` under-reports the true age; the finding row's `since` is durable.

**Live probe (dgx3 `GET /api/v1/nodes/:id/clocks`):**

| Reading | Value | Stored cap | Verdict |
|---|---|---|---|
| GPU `smCapMHz` | **null** | 2200 MHz | **unmeasurable — counted as drift every sweep** |
| GPU `smMHz` (live clock) | 2184 / max 3003 | — | normal |
| CPU `capMHz` | 2000 | 2000 MHz | **matches — no CPU drift** |

**Root cause: structural false positive on GB10.** The driver rejects `clocks.applications.sm` as a `--query-gpu` field, so the agent's GPU cap read-back is always `null` (`apps/agent/src/clocks.ts:12-21,83-85`; documented in `docs/API.md:586` and CHANGELOG IR-187). `clockDrift` counts `null ≠ 2200` as drift (`apps/server/src/clock-caps.ts:69-72` — the guard is only `gpus.length > 0`; the CPU side has the proper "only compare when reported" guard at `:77-82`, the GPU side doesn't). Consequence: **every spark node with a stored GPU cap warns forever, and the warning can never clear.** Confirmed live: all three spark nodes carry the identical finding — DGX-1/2/3 `400 ≥ 4 — ~200 min`, all `since 2026-11-16T05:01:24Z` (±100 ms = one sweep tick, streaks reset together by a hub-wide event ~04:59 and re-accumulate in lockstep; screenshot showed 281/~141 min at ~07:50 — a mid-window reset, choreography unobservable from here).

**By design, nothing re-applies mid-session**: re-assert fires on node hello only (`apps/server/src/hub.ts:343-345` → `index.ts:468` → `clock-caps.ts:101-125`), boot persistence = two irori-managed systemd oneshots (`apps/agent/src/clocks.ts:113-186`, `apps/agent/src/cpu-clocks.ts:160-230`). Round-14 explicitly rejected automatic mid-session re-apply ("the hub can't distinguish an out-of-band operator change from drift"). The badge is display-only; the tooltip (`NodeDetail.vue:411`) says to re-apply from the Clock cap controls.

**Open sub-question:** whether the 2200 MHz GPU cap is *actually enforced* on GB10 is **unobservable** through the current probe (the driver won't report app clocks). `-lgc` state does not survive driver reload or out-of-band `-rgc`; the oneshot re-runs only at boot. A node-side `nvidia-smi -q -d CLOCK` probe is needed (ssh from this workstation is refused — no authorized key for `operator`).

### Q3 — main content left-aligned instead of centered

**Intentional.** The shell is `div.shell` → grid `232px | minmax(0,1fr)` (`apps/web/src/assets/irori.css:118-119`); every view renders inside `<main class="content">` (`apps/web/src/App.vue:335-347`), whose sole geometry rule is `padding: 28px 32px 48px; min-width: 0; max-width: var(--content-max)` = **1360 px, no `margin-inline: auto`** (`irori.css:249`, var at `:71`). Above a ~1692 px viewport the column sits flush after the sidebar (2560 px screen ≈ 868 px empty; the DGX-3 monitor exhibits this). NodeDetail has no own width rules (root `<div>`, `NodeDetail.vue:1001-1002`); no component adds centering.

- Approved mockup: byte-identical rule, also un-centered (`mockups/irori-v11.css:175`; structure `mockups/v11-overview.html:11,41,81`).
- Contract-pinned verbatim: `apps/web/test/ds-markup.test.ts:104`.
- The old shell **did** center: `.container { max-width: 1200px; margin: 0 auto }` (`mockups/irori.css:73`); **IR-217** (Done 2026-11-13, `tasks/IR-217-shell.md:26-28`) deliberately removed it. No feedback round 8–15 asks to re-center [INFERENCE from tasks/ sweep].

So: not a regression — a committed design decision. Changing it = add `margin-inline: auto` to `irori.css:249`, mirror in the mockup CSS, update the `ds-markup.test.ts:104` pin; per DS process, mockup-first.

## Gap analysis

| # | Observation | Gap |
|---|---|---|
| G1 | Install impossible on DGX-3 | **No code gap** — IR-251 (on `main`, in the hub artifact) fixes the agent catch-22; the node bundle is stale. Gap is operational: one agent-update. |
| G2 | Stale bundle invisible | `agentVersion` 0.7.0 is generation-blind; the only exact check today is a manual sha256 diff (hub artifact vs `/opt/irori/irori-agent.mjs`). Operator-visible bundle generation/hash would have made G1 self-evident. |
| G3 | Clock-cap drift false positive | `clockDrift` treats an *unreportable* GPU reading as drift (`clock-caps.ts:69-72`); GB10 can never report → permanent warn on 3/4 nodes. Also `~N min` derives from the in-memory streak instead of the durable `since`. |
| G4 | Content alignment | No gap — matches mockup + test pin. Owner preference only. |

## Proposed design (decisions + rejected alternatives)

**D1 (Q1) — no new code; ops cutover on DGX-3.**
Decision: `POST /api/v1/nodes/359896b6…/agent-update` (hub artifact `dev-0.7.0-24` carries IR-251) → next `models-inventory` auto-dispatches `modelctl-install {user:"operator"}` (IR-247) → verify job output "modelctl 0.24.0 satisfies the 0.24.0 gate" → card shows the real version. Fallback (egress broken): one-off `sudo -u operator uv tool install "modelctl"` on dgx3 — *rejected as the primary path*: it repairs one node and leaves the stale bundle + the catch-22 for any future cache user.
Preconditions: no running setup on the node (verified: none); agent restart stops Irori-supervised setups/benches only.

**D2 (Q2) — S1 Bug: treat "unreportable" as unmeasurable, not drift.**
In `clockDrift` (`apps/server/src/clock-caps.ts:69-72`), skip the GPU comparison when the reading cannot express the side (all GPUs' `smCapMHz` null), mirroring the CPU-side guard (`:77-82`). Fold in the cosmetic fix: derive `~N min` from the finding's `since` (durable) instead of the in-memory streak (`apps/server/src/health.ts:118-129`). Verification step inside the story: on a spark node, `nvidia-smi -q -d CLOCK` to check whether any GB10-visible app-clock section exists (if one does, a fallback read-back could restore real GPU verification later — separate follow-up, not in S1).
Rejected: removing the rule (real CPU drift and future real GPU drift would go unseen); automatic mid-session re-apply (already rejected in round 14 — the hub cannot distinguish intentional operator changes); counting null as "healthy" globally (would hide genuine read failures on GPUs that *should* report — the guard must key on the side being structurally unreportable, i.e. all-null across GPUs, not any-null).

**D3 (optional) — S2 Task: bundle-generation visibility.** Agent hello reports the sha256 of its own `/opt/irori/irori-agent.mjs`; hub diffs it against the served artifact hash; node page/Versions card shows `bundle: current | behind (expected ab12…, running cd34…)`. Kills the semver-≠-generation trap that cost this incident. Rejected: bumping semver per bundle generation (noisy, and the semver is a product version).

**D4 (optional, design decision) — S3 Task: centered content column on ultra-wide screens.** One property (`margin-inline: auto` on `.content`), mockup-first per DS process (`mockups/irori-v14.css` mirror), update the `ds-markup.test.ts:104` string pin. Owner call — the current layout is the endorsed v1.1 design; this story exists only if the owner wants the old centered behavior back.

No ADR required for any of these: no schema, deployment, or boundary change (S2's hello field is additive with a fallback for old agents).

## Phased delivery plan (pending approval)

**Phase A — ops (no ticket, needs explicit owner approval to execute): DGX-3 convergence.**
Agent-update → models refresh → verify install. Acceptance: `modelctl-install` job succeeds with "satisfies the 0.24.0 gate"; `/models` reports `operator 0.24.0, error null` with real model counts; banner gone; auto-provision stops failing. Rollback: none needed (install is additive; agent bundle is the hub-served one).
Order first: it is user-visible pain and unblocks the IR-247 loop.

**Phase B — S1 · Bug (High, per live operator-facing-defect precedent IR-140/151/153): clock-cap drift false positive on unreportable GPUs.**
- `clock-caps.ts`: all-null GPU `smCapMHz` → return `null` (unmeasurable) when a GPU cap is stored, instead of counting drift; CPU guard unchanged.
- `health.ts`: minutes from finding `since`.
- Tests: extend `apps/server/test/clock-caps-ir189.test.ts` — stored GPU cap + all-null reading → no drift; one real revert among multiple GPUs → still drifts; CPU-only mismatch → still drifts.
- Acceptance: after deploy, the three spark-node `clock_cap_drift` findings close on the next sweep and stop re-opening; a real revert (or CPU mismatch) still trips.
- Independent of Phase A; shippable alone.

**Phase C (optional) — S2 · Task (Medium): bundle generation visibility** (see D3). Acceptance: node page shows current/behind + hash prefix for every node; a node running a stale bundle is identifiable from the UI without ssh.

**Phase D (optional) — S3 · Task (Medium): centered content column** (see D4; mockup-first). Acceptance: `.content` centers ≥ the cap threshold in light/dark; `ds-markup.test.ts:104` pin updated with the mockup; no regression below 1692 px.

No DB migrations anywhere. S1 and S2 touch different components; S3 is web-only.

## Risks & open questions

1. **Jira credentials**: no blastersystems pair on this workstation (both local `.mcp.json` entries 401). Creation/verification needs the `JIRA_EMAIL_BLASTERSYSTEMS`/`JIRA_API_TOKEN_BLASTERSYSTEMS` pair exported (e.g. into `~/.bashrc`, read at creation time) or the run done from the Mac. Sprint id must be re-queried (1004 ended 2026-11-15).
2. **Is the 2200 MHz GPU cap actually enforced on GB10?** Unobservable via the current probe; needs a node-side `nvidia-smi -q -d CLOCK` check (ssh denied from here — no key). If not enforced, the boot oneshot is also unverified → follow-up beyond S1.
3. **DGX-1/2 bundle generations are unknown** (semver 0.7.0 generation-blind). Their `operator` already has 0.24.0 so installs gate-skip, but any *new* cache user there would hit the same catch-22 until those nodes are updated. Verify by hash before relying on install there.
4. Hub restarts reset the streak counter; all historical `~N min` values under-report. S1 fixes the display; the true onset per node is the finding `since`.
5. IR-251 is still **Unreleased** (hub runs `dev-0.7.0-24`) — the next release cut must carry it; until then prod web/agent depend on the dev tag.

## Jira overlap findings

- **Live JQL search blocked** (no creds on this box). Repo-side prior art: IR-189 (drift rule, Done), IR-254 (humanized summary + tooltip, Done), IR-247 (null-version auto-provision, on `main`), IR-251 (install catch-22, on `main`, unreleased), IR-207 (UV_TOOL_BIN_DIR pin, Done), IR-126 (hello re-assert, Done), IR-185 (clock-cap API, Done), IR-243/257/258 (update posture, on `main`).
- The round-14 research's own JQL sweep (2026-11-15) found no open ticket for any node-page item; none of the three gaps identified here (GB10 null-readback false positive, bundle-generation visibility, content centering) has an open ticket. S1/S2/S3 are new; the dgx3 ops step needs no ticket.

## Delivered (2026-11-16)

- Tickets created (per-key verified; **backlog** — the only listed "active" sprint 1004 ended 2026-11-15 and rejects adds, no future sprint exists → pull at next planning):
  - **IR-259** (Bug, High) — S1 clock-cap drift false positive on unreportable GPUs.
  - **IR-260** (Task, Medium) — S2 bundle-generation visibility.
  - **IR-261** (Task, Medium) — S3 centered content column (mockup-first).
  - Relates: IR-259 ↔ IR-260, IR-259 ↔ IR-261. This doc posted as IR-259 comment id 26092 (62 blocks, end-verified).
- **Ops executed (hub API):** agent-update on DGX-3 **succeeded** (job `373b6733`, "bundle replaced — restarting irori-agent", "update confirmed: agent reports 0.7.0") — dgx3 now runs the current `dev-0.7.0-24` generation with the IR-251 fix.
- **Install blocker moved one level deeper:** `modelctl-install` now fails inside uv — `failed to remove directory /home/operator/.cache/uv/git-v1/db/81c7185ba20fa954: Permission denied (os error 13)` — root-owned artifacts left in operator's uv state by the old IR-207 cross-user redirect. Node-side fix (no ssh path from this workstation; executor key refused by dgx3):
  `sudo chown -R operator:operator /home/operator/.cache/uv /home/operator/.local/share/uv` on dgx3, then re-run Install (button, `POST modelctl-install {user:"operator"}`, or let IR-247 auto-provision retry after the next inventory read).
  Confirmed live 2026-11-16: after the first chown, the retry got past the git cache and failed on the sibling dir — `failed to remove file /home/operator/.local/share/uv/tools/modelctl/uv-receipt.toml: Permission denied` — root-owned uv **tool** dir; both XDG dirs must be chowned.
