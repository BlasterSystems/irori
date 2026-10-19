# IRI-011/012 research brief — hub-served agent artifacts & hub-driven updates

Date: 2026-10-19. Scope: how the agent gets onto a node today, why updates are
manual, and what existing machinery a no-credentials update path can ride.

## Current state (evidence)

- **Onboarding needs GitHub twice.** The modal shows only the usage line
  (`apps/web/src/components/NodeModal.vue:48-49,155-157`). The script ships as
  a release artifact (`​.github/workflows/release.yml:82,91`) and fetches the
  bundle from GitHub releases too (`apps/agent/install-agent.sh:32-38`,
  `--bundle-url` override exists). `docs/DEPLOYMENT.md:78-82` documents the
  GitHub curl; `docs/SPEC.md:338` lists a `/:id/install-agent` route that was
  never built. The unit file is expected next to the script
  (`install-agent.sh:49-55`) — a script downloaded alone cannot complete a
  fresh install.
- **Updates are fully manual.** No update path exists: `config-update` carries
  only cadence/llmPorts/llmCadence/nasRoot
  (`packages/core/src/agent-messages.ts:47-51`, `apps/server/src/hub.ts:91-97`);
  no self-update message; no version push. An update = replace
  `/opt/irori/irori-agent.mjs` + restart (token/env/unit untouched — the env
  file is only rewritten by an `install-agent.sh` re-run, with identical
  values).
- **The machinery for hub-driven updates already exists.** The agent executes
  server-supplied jobs over the token-authenticated outbound WS (ADR-0003);
  job kinds are a core enum (`packages/core/src/jobs.ts:9-27`) and non-modelctl
  kinds already run agent-side scripts (`modelctl-install` builds a bash
  script via `buildCommand`, `apps/agent/src/modelctl.ts:92-110`; hygiene runs
  in-agent, `apps/agent/src/jobs.ts:50-70`). `reapOffline` fails running jobs
  whose node dropped (`apps/server/src/jobs-service.ts:271-283`, invoked from
  a 60 s loop, `apps/server/src/index.ts:260-270`), the hello persists
  `agentVersion` (`hub.ts` markSeen) and hello-ok already carries
  `serverVersion` — and `isAgentSupported` gates hellos
  (`packages/core/src/version.ts:18-20`, MIN_AGENT_VERSION).
- **Restart-from-inside-a-job is lethal to the job.** `irori-agent.service`
  sets no `KillMode` (`apps/agent/irori-agent.service`) → systemd default
  `control-group`: a `systemctl restart irori-agent` issued from a job process
  kills the job itself (it lives in the agent's cgroup). A transient
  `systemd-run --pipe --wait` unit runs in its own cgroup and survives; after
  the restart the agent process (and the blocking `systemd-run` client) are
  gone, but the service completes.

## Decisions

1. **The hub serves its own version's artifacts.** `GET /install-agent.sh`,
   `GET /irori-agent.service`, `GET /agent/irori-agent.mjs` — resolved from
   `IRORI_AGENT_ARTIFACTS_DIR` (container, flat) or the monorepo `apps/agent`
   layout. One source of truth (`apps/agent/`), zero-internet onboarding,
   GitHub stays the release fallback via `--bundle-url`. The update target is
   always the hub's own version, so hub and agents never drift apart across a
   deploy.
2. **No credentials, ever.** The update rides the existing WS job channel; the
   token lives in `/etc/irori/agent.env` and is never rewritten. SSH-assisted
   install was considered and discarded by the owner: the hub is
   unauthenticated (ADR-0002), so stored SSH secrets would be an
   LAN→root-on-all-nodes escalation path.
3. **Update completion is hello-driven, not frame-driven.** The restart kills
   the socket mid-job, so no `job-done` can arrive for the success path:
   - pre-restart failure → normal `job-done` failed (agent still connected);
   - success → agent reconnects → `settleAgentUpdate` compares the hello's
     `agentVersion` to the job's `expectedVersion` → succeeded; on mismatch
     the job stays running (a reconnecting old agent during a network blip
     must not fail an in-flight update);
   - node never returns → the 60 s reaper fails the job after a 10 min grace
     (`AGENT_UPDATE_GRACE_MS`), with a `.bak`/journalctl hint;
   - server restart mid-flight → same reaper rule; restart-safe (no timers,
     no in-memory maps).
   `reapOffline` must therefore skip young `agent-update` rows — without the
   carve-out the reaper would fail every update during its restart window.
4. **Guards before dispatch.** The single-active-job rule (jobs table +
   `jobs_node_active_uq`) covers jobs and staged-transfer stages; the route
   additionally refuses while a bench is `running` (`benchService.active`)
   or a setup is `starting`/`running`/`stopping` on the node — an agent
   restart kills everything the agent supervises (setups are its children).
   The UI copy states this.
5. **The update script is agent code, not server input.** The job kind joins
   the enum; the agent builds a fixed argv (`systemd-run … bash -c SCRIPT`)
   with the hub URL derived from its own `IRORI_SERVER_URL` (`ws:`→`http:`,
   strip `/agent-ws`). `node --check` validates the downloaded bundle before
   it replaces the live one; the previous bundle is kept as `.bak`. The
   server passes only `expectedVersion` (opaque params record, as with other
   kinds).

## Rejected alternatives

- **SSH/sshpass or ssh2 install** — stores root-adjacent secrets next to an
  unauthenticated hub; discarded (Phase 2).
- **Agent self-update on hello-ok version mismatch** — silent infra mutation;
  updates stay operator-clicked (SPEC's no-surprise posture).
- **Timers/maps in jobs-service for the timeout** — lost on server restart;
  the reaper-loop rule is restart-safe by construction.
- **Serving artifacts from GitHub only** — fails air-gapped/IPv6-only nodes
  and makes onboarding depend on a third party from the node.

## Consequences

- `docker/Dockerfile` server role ships `install-agent.sh`,
  `irori-agent.service`, `dist/irori-agent.mjs` and points
  `IRORI_AGENT_ARTIFACTS_DIR` at them; degraded (no-DB) mode still serves
  them.
- ADR-0007 records the artifact + update contract; ADR-0003's runtime link
  (outbound WS, privileged agent) is unchanged; ADR-0002's no-auth posture is
  explicitly relied upon, not weakened.
