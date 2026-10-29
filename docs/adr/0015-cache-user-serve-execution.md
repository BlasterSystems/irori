# ADR-0015: Cache-user serve execution

- **Status:** Accepted
- **Date:** 2026-10-29
- **Decision owners:** Bruno Pires
- **Scope:** Serving orchestration, setup supervision driver, agent command surface
- **Tags:** serving, runuser, cache-user, security, setups, agent
- **Supersedes:** None
- **Superseded by:** None

## Context

The serving driver spawns a setup's start/stop scripts as the **agent user**
(root, ADR-0003) with the agent's ambient environment — `spawn(scriptStart, …,
env: { ...process.env, ...finalEnv })`. Two defects fall out of that on nodes
with a `cacheUser` configured (ADR-0011):

1. **Serve runs as root.** ADR-0011 scoped the `runuser` wrap to modelctl
   operations (`sync-local`, `push`, `delete-local`, inventory, and — IR-120 —
   MODEL_PATH resolution). The engine process itself was never wrapped, so a
   setup whose MODEL_PATH resolves into `piresbruno`'s HF cache still served it
   as root. Owners checking `ps` saw the engine as root, not the configured
   cache user.
2. **The HOME-less agent unit breaks `set -u` scripts.** The agent's systemd
   unit sets no `HOME` (systemd gives system services none), and the driver
   passes the ambient env through. Any start script chain that dereferences
   `$HOME` under `set -u` dies unbound — observed live on DGX-1:
   `./scripts/config.sh: line 340: HOME: unbound variable`, start exit 1,
   capture proxy torn down. `USER`/`LOGNAME` are equally absent.

## Decision drivers

- One execution story per node: what transfers stage, the serve should run —
  the cache user owns the model files and reads them by default.
- The privileged-agent boundary (ADR-0003) must not widen: user names stay
  argv-only, homes resolve agent-side from `/etc/passwd`.
- `set -u` start scripts are a supported surface; missing ambient env vars
  must not fail starts.
- A stop must reach an engine owned by whoever started it, even across agent
  restarts and mid-run node-setting edits.

## Considered options

### Option 1: Run serve as root; document `$HOME` workaround

Owners export `HOME` in their start scripts. No code change; engines keep
running as root and reading the wrong cache by default. Rejected: repeats the
IR-101 class of split-brain between the supply chain (cache user) and the
consumer (root).

### Option 2: HOME injection only

Inject `HOME` (the agent user's passwd home) when the ambient env lacks it.
Fixes the unbound-variable crash but keeps root execution.

### Option 3: Wrap serve start/stop in the ADR-0011 runuser shape (chosen)

When the node has a `cacheUser` different from the agent user, the driver
spawns both scripts as `runuser -u <user> -- env -u XDG_STATE_HOME -u HF_HOME
-u HF_HUB_CACHE HOME=<user home> PATH=<ambient> USER=<user>
LOGNAME=<user> <script>`. Scrubbed HF/XDG vars force HOME-based per-user
defaults; the ambient PATH (not modelctl's 4-dir PATH) is kept because engines
need more than `~/.local/bin`. A missing passwd entry refuses the start with
an actionable error — never a silent root fallback. Without a cache user (or
when it equals the agent user), scripts run as before plus the Option-2 HOME
fallback. The resolved wrap persists on the driver record, so a stop after an
agent restart — or a mid-run `cacheUser` edit — still runs the stop script in
the run's original context.

## Decision

Option 3, with the Option-2 fallback for unwrapped nodes. The wrap reuses the
shared `runuserWrap` helper extracted from `modelctl.ts` (also adopted by
`inventory.ts`'s `userArgv`), keeping one ADR-0011 argv shape across transfers,
local ops, resolution, and serving. Serving prerequisites are the owner's: the
cache user needs GPU device access and read access to the model paths it owns
(the HF cache is theirs), and engine ports stay >1024.

## Consequences

### Positive

- Engines run as the configured cache user; `ps` matches the supply chain.
- `set -u` start/stop scripts stop dying on `$HOME` (and `$USER`/`$LOGNAME`
  under the wrap) on every agent-installed node.
- One shared wrap implementation instead of four copies of the argv shape.

### Negative

- Nodes with a cache user whose engine prerequisites are missing (GPU device
  permissions for that user) now fail at start with the engine's permission
  error — previously they "worked" as root.
- Two more driver-record fields (`runUser`/`runHome`) persisted per run.

### Risks and mitigations

- Command injection through the user name — unchanged from ADR-0011: strict
  username pattern validated at the API and re-checked agent-side; the value
  interpolates only into `runuser` argv (no shell).
- Script/flag injection through resolved paths — none: homes come from
  `/etc/passwd` agent-side; the hub sends only the user name.
- Engine user cannot write logs/state — none needed: stdout/stderr stream back
  over the driver's pipes; the driver writes log files as root.

## Implementation and validation

Agent-only: `apps/agent/src/cache-user.ts` (shared `runuserWrap`), `setups.ts`
(`resolveServeWrap`, `serveSpawnArgv`, `runUser`/`runHome` on the driver
record, stop-script wrap + pre-IRI-045 HOME fallback), `inventory.ts`
(`resolveCacheHome` passwd-only resolver), `main.ts` wiring. Validated by unit
tests pinning the wrap argv, the passwd refusal, the wrapped start/stop env
execution (runuser test double), the persisted run context, and the unwrapped
HOME fallback; existing transfer/local-op argv tests are unchanged by the
refactor.

## Revisit triggers

- Fleet-wide move to non-root agents (ADR-0003 revisit) — the wrap becomes the
  default execution path and `runuser` may go away.
- Per-setup (not per-node) execution users.
- Engines needing ambient HF overrides (e.g. a deliberate `HF_HOME`) — the
  scrub list would need an escape hatch.

## References

- IRI-045 (task file); live owner report from DGX-1 (`HOME: unbound variable`
  start crash, root serve observation)
- ADR-0011 (per-node cache user transfers), ADR-0003 (privileged agent),
  ADR-0008 §7 (capture proxy `$PORT` contract), ADR-0013 (per-user modelctl
  provisioning)
