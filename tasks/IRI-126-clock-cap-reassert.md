# Task: IRI-126 — clock caps re-apply on node online, drift rule, fleet apply

Jira **IR-189** (Task, Medium). Implements the SPEC §10 promise that was
explicitly marked "not yet implemented".

## Objective

SPEC §10 said the desired GPU/CPU clock state is re-applied on every node
online transition and can be applied fleet-wide. Neither existed: persistence
was only the boot-time oneshots (`irori-gpu-clock-cap.service`,
`irori-cpu-clock-cap.service`). That matters because a DGX OS component
rewrites `scaling_max_freq` after boot (observed mtime drift on DGX-1) and the
governor every ~2 minutes, so a cap can be silently reverted while the
registry still claims it.

## Acceptance criteria

- [x] On node online, compare the stored caps with the agent's live clocks
      reading and re-apply on mismatch (not unconditionally — a reconnect
      storm must not hammer `nvidia-smi`).
- [x] Re-apply never touches persistence: the registry already holds the
      desired state and the boot oneshot is already installed or not per
      `*ClockCapPersistent`.
- [x] A side is only compared when a cap is stored AND the reading can express
      that side (old agent without `cpu`, empty `gpus` = collector failure).
- [x] Health rule when the observed ceiling differs from the stored cap for
      more than N minutes (N = 4 sweeps × 30 s = 2 min, operator-tunable).
- [x] Fleet-wide apply: one action fans out to every enabled spark node with
      per-node results.
- [x] Unit tests for the comparison, the re-assert, the streak, the fleet
      route; db-gated tests for the health rule.

## Scope

- `apps/server/src/clock-caps.ts` (new): `clockDrift()` (pure comparison),
  `createClockCapService()` with `reassert()` and `driftStreak()`.
- `apps/server/src/hub.ts`: `onNodeOnline` dep, fired once per authenticated
  hello after the config-update.
- `apps/server/src/index.ts`: wires the service, the hello hook, and the
  health sink.
- `apps/server/src/health.ts`: `clockDrift` sink + the `clock_cap_drift` rule
  in the sweep. The three duplicated appear/cooldown/clear blocks collapsed
  into one `evaluate()` helper (the drift rule would have been a fourth).
- `apps/server/src/app.ts`: `POST /api/v1/clock-cap` (fleet).
- `packages/core/src/health.ts`: `clock_cap_drift` metric + seed rule.
- `apps/web`: `setFleetClockCap()` and the Overview "Fleet clock caps" card.

Not in scope: the agent side. `clocks-get`/`clocks-set` already carry
everything needed; no wire change.

## Design notes

- **Compare, don't blindly re-apply.** A reconnect storm (IR-179) would
  otherwise issue an `nvidia-smi -lgc` per node per reconnect. The read is
  cheap and already exists.
- **The drift metric is a streak count, not a boolean.** That makes the
  "more than N minutes" requirement the rule's own threshold, so an operator
  can tune it in the health UI without a code change.
- **Fleet status codes are per-node.** 200/207/502 rather than a blanket 200,
  so a partial fleet is not reported as success.

## Verification

- `pnpm --filter @irori/server test` with `IRORI_TEST_DATABASE_URL` — 394
  passed (18 new in `clock-caps-ir189.test.ts`, 2 new db-gated in
  `health-ir69.test.ts`).
- Live smoke against a local server + fake agent over the real WS protocol:
  set a cap → agent received `clocks-set`; reconnect with the cap reverted →
  `clock cap re-applied … gpu default → 2000 MHz`; fleet apply → 200 with
  per-node results for both sides.
- `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check --strict`.
