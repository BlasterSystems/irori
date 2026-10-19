# ADR-0007: Hub-served agent artifacts and hub-driven updates

- **Status:** Proposed
- **Date:** 2026-10-19
- **Decision owners:** Bruno Pires
- **Scope:** Agent onboarding artifacts, agent update path, server image contents, job-kind surface
- **Tags:** agent, deployment, security, websocket, jobs, docker
- **Supersedes:** None
- **Superseded by:** None

## Context

The agent install story required GitHub reachability twice — the operator had
to obtain `install-agent.sh` (release artifact only; the Add-node modal merely
prints its usage line) and the node had to fetch `irori-agent.mjs` from GitHub
releases. Updates were fully manual per node per release (re-download the
bundle, restart the unit). SSH-assisted install was considered and discarded:
the hub is unauthenticated by design (ADR-0002), so stored SSH credentials
would hand LAN-level hub compromise root on every node.

## Decision drivers

- Onboarding and updates must work with hub-only reachability (no internet on
  the node).
- No credentials may be stored or re-entered (ADR-0002 trust model).
- The agent is privileged and executes server-supplied jobs (ADR-0003) — the
  update path must not widen that surface.
- Hub and agent versions must not drift: the served bundle must be the one
  that matches the running server.
- Restart-safety: server restarts, network blips, and crash-looping new
  bundles must all settle to an observable terminal state.

## Considered options

### Option 1 — GitHub-only artifacts, manual updates (status quo)

Zero new code. Costs: onboarding breaks without internet, updates are manual
per node per release, and the modal's instruction is not actionable from the
UI.

### Option 2 — SSH-assisted install (server holds credentials)

One-click onboarding of offline nodes. Costs: `ssh2` dependency, stored
root-adjacent secrets next to an unauthenticated hub, an ADR-level trust
model change. **Rejected** by the owner.

### Option 3 — Hub-served artifacts + WS job-channel updates (selected)

The hub serves its own version's installer, unit and bundle; updates dispatch
as an `agent-update` job over the existing token-authenticated WS and execute
in a `systemd-run` transient unit that survives the agent's own restart.

## Decision

Adopt option 3.

1. **Artifact serving.** `GET /install-agent.sh`, `GET /irori-agent.service`
   and `GET /agent/irori-agent.mjs` serve the repo copies from
   `apps/agent/` (monorepo) or `IRORI_AGENT_ARTIFACTS_DIR` (container);
   missing artifacts answer 503 JSON. The server image ships all three, so
   the hub's served bundle always matches the hub's version. GitHub remains
   the release-artifact fallback (`--bundle-url`).
2. **Update flow.** `POST /api/v1/nodes/:id/agent-update` (records
   `expectedVersion` = hub version) dispatches the new `agent-update` job
   kind. The agent runs a fixed script as `systemd-run --collect --pipe
   --wait --unit=irori-agent-update-<id8> --setenv=IRORI_SERVER_URL=… bash -c
   …`: fetch hub bundle → `node --check` → keep `.bak` → atomic `mv` →
   `systemctl restart irori-agent`. The transient unit's own cgroup is what
   makes surviving the restart possible (the agent unit sets no `KillMode`,
   so the systemd default `control-group` would kill a job-internal restart).
3. **Completion semantics.** Pre-restart failures settle via normal
   `job-done`. Success settles on the node's next hello — the hub's
   `jobEvents.onHello` hook compares the reported version to
   `expectedVersion` and settles `succeeded` on match, otherwise leaves the
   job running (a blip-reconnecting old agent must not fail an in-flight
   update). `reapOffline` skips `agent-update` rows younger than 10 minutes
   and fails older ones with a `.bak`/journalctl rollback hint; this lives in
   the existing reaper loop, so it survives server restarts.
4. **Guards.** The single-active-job rule (table + `jobs_node_active_uq`)
   covers jobs and transfer stages; the route additionally refuses while a
   bench is running or a setup is `starting`/`running`/`stopping` on the
   node, because restarting the agent kills everything it supervises.

## Consequences

### Positive

- Onboarding: download + one copyable block, works air-gapped from the hub's
  perspective; the modal instruction is finally actionable.
- Updates: one click per online agent; zero credentials requested or stored;
  hub/agent versions cannot drift (target = hub's own version).
- No new secrets, tables, or migrations; no auth-model change.

### Negative

- The hub becomes the distribution point for an executable script — it
  already serves the whole UI unauthenticated, so no new trust class, but the
  operator must protect the hub as before.
- A failed restart leaves the node offline (mitigated: `.bak` + journalctl
  hint in the job output; manual recovery).
- Rolling the hub back leaves updated agents ahead; re-dispatching the update
  after a rollback re-aligns them.

### Risks and mitigations

- *Serving a malicious script*: only possible from a compromised hub, which
  already implies full UI/API compromise (ADR-0002). Mitigation: serve only
  repo-owned bytes; no operator input is embedded.
- *Update kills a running bench/setup*: refused server-side (409) and stated
  in the UI copy.
- *Job stuck `running` forever* (agent online but script hung): the update
  script bounds its own network I/O (`curl --max-time`); a hung pre-restart
  script ends in `job-done` failed.
- *Duplicate transient units*: unit name embeds the job-id prefix; `--collect`
  garbage-collects failed runs.

## Implementation and validation

- IRI-011 (IR-57): artifact routes + resolver, NodeModal download block,
  Dockerfile packaging; route tests + live curl diff against the repo copy.
- IRI-012 (IR-58): job kind, dispatch route + guards, `onHello` settle hook,
  reaper carve-out, agent job branch, drift badge + update button; unit tests
  for reaper/settle semantics + live smoke with a scripted WS agent.

## Revisit triggers

- A real need to update offline agents (reopens the credentialless-SSH or
  pull-mode discussion — e.g. an agent-side periodic version check).
- Hub/agent protocol versions diverge such that old agents can no longer
  understand `job` frames (needs a bootstrap path).

## References

- docs/research/IRI-011-research-brief.md (evidence with file:line)
- ADR-0002 (no app auth; secrets posture), ADR-0003 (privileged agent,
  outbound WS), ADR-0004 (job-kind precedent), ADR-0006 (validated contracts)
- Jira IR-57 (IRI-011), IR-58 (IRI-012)
