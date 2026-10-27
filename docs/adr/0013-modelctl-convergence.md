# ADR-0013: Modelctl convergence — hub-pinned pin, per-cache-user provisioning, inventory-triggered

- **Status:** Accepted
- **Date:** 2026-10-27
- **Decision owners:** Bruno Pires
- **Scope:** apps/server, apps/agent, packages/core, fleet ops
- **Tags:** modelctl, provisioning, jobs, inventory, config-update
- **Supersedes:** None
- **Superseded by:** None

## Context

modelctl is the supply-chain engine; every store mutation and per-user cache
op runs through it. Its version lives per node and per cache user
(`IRORI_MODELCTL_PIN` env for the agent's own install; each cache user has an
independent `uv` install). Observed on the fleet (2026-10-27): root's
modelctl moved to 0.21.3 while a cache user stayed on 0.20.1 — the
`modelctl-install` job hardcodes the agent's own `/root/.local/bin` PATH, so
cache users never converge; and the version gate runs after the forced
install, so a stale env pin would silently downgrade a newer binary
(IRI-021's known residual: "spark agents may carry stale env pins").

## Decision drivers

- Cache users (ADR-0011) run their own modelctl — a root-only install does
  not help transfers, delete-local, or register-local.
- A modelctl upgrade must be deliberate: the hub decides the version, never
  "latest" (a bad release must not roll out fleet-wide unattended).
- The fleet must converge without per-node SSH (a manual `uv tool install`
  per user is exactly the friction being removed).
- Existing machinery: the version-gated `modelctl-install` job (ADR-0004),
  the runuser cache-user pattern (ADR-0011), the models-inventory report
  (per-cache-user `modelctlVersion`), and config-update (ADR-0007).

## Considered options

### Option 1 — keep the per-node env pin, manual per-user installs

Smallest change. Keeps the stale-env downgrade hazard and the per-node SSH.

### Option 2 — agent self-provisions on hello

No hub changes, but installs happen outside the job system: invisible in the
job drawer, no one-active guard, hard to audit.

### Option 3 — hub-pinned pin + per-user install job + inventory-triggered dispatch (adopted)

The pin moves to a hub setting (`modelctl_pin`) carried in config-update (the
node env stays as fallback for agents that never receive it). The install
job takes an optional cache `user` (runuser per ADR-0011) and checks the
current version before installing: current ≥ pin skips, current < pin
upgrades — never a downgrade. After every succeeded models-inventory read
the hub dispatches one `modelctl-install {user}` per cache user whose
reported version is below the pin, silently skipping when the pin is unset,
the node already has an active job (JobBusyError), or the agent is offline
(JobDispatchError) — the next inventory read retries.

## Decision

Option 3.

## Consequences

### Positive

- One knob fleet-wide; stale env pins stop mattering (and can no longer
  downgrade).
- Cache users converge automatically after their next inventory read; the
  install jobs are visible in the job drawer and respect the one-active
  guard.

### Negative

- Auto-dispatched jobs appear without an owner request (by design).
- The install needs network (uv → GitHub); a failed install retries on the
  next inventory read with no backoff.

### Risks and mitigations

- A bad pinned release rolls out fleet-wide → the pin is deliberate (a hub
  setting); the previous modelctl stays until the install completes (uv tool
  installs are atomic per tool), and modelctl 0.23+ operations fail closed
  on verification mismatches.
- Install jobs colliding with owner work → the one-active guard turns the
  dispatch into a no-op (409 caught), never a preemption.
- Stale env pins → skip-if-newer gate plus the hub pin override.

## Implementation and validation

- Core: `modelctl_pin` setting schema + `modelctlPin` in config-update
  (tri-state like hfToken); `MODELCTL_PIN_RE`.
- Agent: `modelctl-install {user?}` — runuser wrapper with the resolved
  home/binary, `$HOME/.local/bin` PATH, skip-if-newer pre-check before the
  forced install; the ctx pin prefers config-update over env.
- Server: setting service + GET/PUT routes (PUT pushes config-update to
  online agents); on a succeeded models-inventory settle the hub dispatches
  one install job per below-pin cache user.
- Tests: core schema/config-update, agent argv matrix (root, per-user,
  unknown user, skip-before-install ordering), server routes (503/400/
  roundtrip + config push), job-events auto-dispatch (below-pin dispatch,
  unset-pin no-op).
- Validation: full suites on a disposable Postgres; live: the hub
  config-update carries the pin, and a below-pin cache user converges after
  its next inventory read.

## Revisit triggers

- modelctl gains a native self-update or the pin moves into modelctl's own
  state.
- Auto-dispatch proves noisy (repeated failing installs) — add backoff or a
  per-node opt-out.

## References

- ADR-0004 (modelctl as supply-chain engine), ADR-0011 (per-node cache user
  transfers), ADR-0007 (hub-served agent artifacts and updates).
- IR-106 / IRI-035 task record (`tasks/IRI-035-modelctl-convergence.md`);
  PR link added at merge.
