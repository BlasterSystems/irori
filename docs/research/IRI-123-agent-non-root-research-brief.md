# IRI-123 research brief — non-root agent without interactive sudo

- **Date:** 2026-10-28
- **Ticket:** IR-123 (next after IR-122; create at implementation start)
- **Goal:** Can `irori-agent` run as a non-root systemd service with **no password prompts ever** — and what breaks?

Context: owner pivot during the IR-122-era HOME-unbound investigation (`./scripts/config.sh: HOME: unbound variable` on serve start). A `User=` unit sets `HOME` structurally (§3), so the one-line agent fix is subsumed by this redesign.

---

## 1. What actually requires root today (code inventory)

Full audit of `apps/agent` @ main (scout agent, 2026-10-28; every row read from source). Root-coupled surfaces, and only these:

| # | Surface | Evidence | Root? | Non-root path |
|---|---|---|---|---|
| 1 | The unit itself | `apps/agent/irori-agent.service` — no `User=`, only `Environment=PATH=` | yes (defaults root) | `User=` + systemd group semantics (§3) |
| 2 | Agent self-update | `apps/agent/src/jobs.ts:17-44` script (`curl → node --check → cp .bak → mv` under `/opt/irori`, then `systemctl restart irori-agent.service`) wrapped in `systemd-run --collect --pipe --wait --expand-environment=no --unit=irori-agent-update-<id12> --setenv=IRORI_SERVER_URL=… bash -c …` (`jobs.ts:47-64`) | yes ×3: system transient, `/opt/irori` write, system-unit restart | run the **whole transient via `sudo -n`** → transient is root, does everything root, zero chown (§5.2) |
| 3 | Cache-user wrap | `apps/agent/src/modelctl.ts:207-209` — `asCacheUser` returns argv unwrapped when `cacheUser` unset **or equals `agentUser`**; else `runuser -u <user> -- env … ` (`:210-228`) | `runuser` is root-only by design (util-linux: "may be executed by the root user only") | constraint: `cacheUser` == service user on non-root agents; wrap auto-skips (`modelctl.ts:209`) |
| 4 | ensure-rsync | `apps/agent/src/modelctl.ts:404-423` — `apt-get update -qq` + `apt-get install -y rsync` | yes | sudoers the two exact argvs; installer also preinstalls rsync so the path is cold |
| 5 | Hygiene apt/journal | `apps/agent/src/hygiene.ts:668-669` (`apt-get clean`, `apt-get autoremove --assume-yes`), `:676` (`journalctl --vacuum-time=14d`) | yes | sudoers exact argv; journal *read* already fine via `adm` (§2) |
| 6 | Hygiene system-junk rm | `hygiene.ts:683-712` — `/var/crash`, `/var/lib/apport/coredump`, `/tmp >7d` | partly; sticky bit limits `/tmp` to own files; crash dirs root-owned | graceful per-category skip when not writable (small code change); category is best-effort by design |
| 7 | docker CLI | `hygiene.ts:322-324,351,557,563-564,569,580,762,767` → `/var/run/docker.sock` (`srw-rw---- root docker`) | root **or** docker group | none needed — agent user in `docker` (§2) |
| 8 | daemon.json hygiene-prevent | `hygiene.ts:729-757` writes `/etc/docker/daemon.json` + `.irori-backup` | yes (root-owned path) | one-time `chgrp docker /etc/docker/daemon.json && chmod g+w` in migration |
| 9 | State layout | `config.ts:77` `IRORI_MODELCTL_PATH` default **literal `/root/.local/bin/modelctl`**; `config.ts:79-81` state = `XDG_STATE_HOME\|$HOME/.local/state/irori-agent` | no, but /root defaults | default → `join(homedir(), ".local", "bin", "modelctl")` (one-line code change; env override stays) |
| 10 | Kill/cleanup of children | `setups.ts:414-426,482-497` `kill(-pgid)`, job cancel `modelctl.ts:685-691` | no — own pgids only; EPERM paths already try/catch (`setups.ts:92-100`) | none |
| 11 | Capture proxy bind | `packages/proxy/src/proxy.ts:116` `listen(port, "0.0.0.0")` | only if a setup port <1024 | fleet convention is ≥1024 (`:8081` etc.); `net.ipv4.ip_unprivileged_port_start` escape hatch documented, no code |
| 12 | Telemetry reads | `collector.ts:189-218` nvidia-smi query argv ×3; `/proc`, `/sys`, hwmon reads | no | none; `/dev/nvidia*` is 0666 (§2) |
| 13 | Install-time | `apps/agent/install-agent.sh:34` EUID guard; `/opt/irori`, `/etc/irori`, node pin, unit sed `:47-96` | yes, one-time human | stays root — the migration IS a re-install |

**Negative result (load-bearing):** the GPU/CPU *control* promised by `docs/SPEC.md:326-333` and `docs/adr/0003-*-privileged-agent-outbound-ws.md:55-59` ("clock/power control… re-applied on every online transition") **has no implementing code** — repo-wide grep for `-lgg/-lgc|--power-limit|persistence-mode|scaling_*_freq` writes hits docs only; `collector.ts` reads clocks via `--query-gpu=…clocks…` (unprivileged). The agent's root-ness buys almost nothing today: the privileged set is the unit, the update path, runuser, apt/journal, and file ownership.

## 2. Live fleet facts (dgx3, 2026-10-28, ssh probes)

- `piresbruno` uid 1000, groups: `adm sudo audio dip plugdev users lpadmin docker` → docker socket rw ✓, journal read ✓, no new groups needed.
- `/opt/irori{,/node}` and bundle: `root:root 755/644`. `/etc/irori` 755; `agent.env` `600 root` — read by systemd pid1 (`EnvironmentFile=`), never by agent code → works unchanged under `User=`.
- polkit 124 present; `/etc/polkit-1/rules.d` not user-readable; **`/etc/sudoers.d` has zero custom entries** (greenfield).
- `/dev/nvidia*` `crw-rw-rw-` → NVML/nvidia-smi reads unprivileged ✓.
- `nvidia-persistenced`: **active + enabled** → agent never needs `-pm`.
- Unprivileged clock change **fails today**: `nvidia-smi -lgc 900,3003` → “The current user does not have permission to change clocks” rc=4 (same `-rgc`). NVML: all device mutation is root-only; `nvmlDeviceSetAPIRestriction` relaxation is root-set, driver-lifetime-only, and documented for the (deprecated) applications-clocks/auto-boost buckets — locked-clocks coverage on driver 580.178.04 unproven. → when clock control lands, scope sudoers per the GB10 industry pattern (§5.4).
- No `intel-rapl` on this ARM board (energy reads n/a there); `scaling_governor=performance`, root-only write (future).
- systemd 255. Man page (`systemd.exec(5)`), quoted: `SupplementaryGroups=` “does not override, but **extends** the list of supplementary groups configured in the system group database for the user” → `User=piresbruno` gets `docker`/`adm` with zero unit config. `SetLoginEnvironment`: “controls whether to set `$HOME`, `$LOGNAME`, and `$SHELL` … If unset, this is controlled by whether `User=` is set” → **HOME exists under `User=`** — the IR-122-era `HOME: unbound variable` crash is structurally fixed; no agent-side env patch required.

## 3. Identity: which user?

| | `piresbruno` (recommended) | dedicated `irori` user |
|---|---|---|
| Model caches / recipes / ssh / NAS mounts | already his; `cacheUser==agentUser` holds with **zero data migration** | re-point cacheUser, reinstall modelctl, NAS share ACLs, re-issue transfer keys |
| Blast radius of agent compromise | = user account (fine: single-admin homelab) | isolated |
| Precedent | nodes are personally administered (ssh config, manual installs) | cleaner for multi-tenant later |

Dedicated user is the "proper service" answer but buys nothing on a 4-node personal fleet while costing a data migration. **Default: `User=piresbruno`.** Revisit trigger: any second human tenant.

## 4. Enforcement mechanism: one sudoers drop-in, no polkit

polkit cannot see `nvidia-smi`/`apt`/plain executables; sudoers covers every surface with one auditable file. `/etc/sudoers.d/irori-agent` (0440, `visudo -c`-validated at install):

```sudoers
# agent-update: fixed argv prefix; the transient itself runs as root
piresbruno ALL=(root) NOPASSWD: /usr/bin/systemd-run --collect --pipe --wait --expand-environment=no --unit=irori-agent-update-* --setenv=IRORI_SERVER_URL=* bash -c *
piresbruno ALL=(root) NOPASSWD: /usr/bin/systemctl restart irori-agent.service
# hygiene
piresbruno ALL=(root) NOPASSWD: /usr/bin/apt-get clean
piresbruno ALL=(root) NOPASSWD: /usr/bin/apt-get autoremove --assume-yes
piresbruno ALL=(root) NOPASSWD: /usr/bin/journalctl --vacuum-time=*
piresbruno ALL=(root) NOPASSWD: /usr/bin/apt-get update -qq, /usr/bin/apt-get install -y rsync
# future clock control (GB10 pattern; add with the feature, not before)
piresbruno ALL=(root) NOPASSWD: /usr/bin/nvidia-smi -lgc *, /usr/bin/nvidia-smi -rgc
```

Agent calls become `sudo -n <exact argv>`; `-n` guarantees never-prompt (fails loud instead of hanging the job). **Verify during implementation** that sudoers `*` argument matching spans the multi-word `bash -c <script>` tail (`sudo -l -U piresbruno` output); fallback if not: a 10-line root-owned `/usr/local/lib/irori/agent-update` wrapper taking `<jobid> <url>`, single sudoers line. Rejected: polkit JS rules (second mechanism, opaque, still need sudoers for nvidia-smi/apt anyway).

## 5. Design of the change

1. **Unit** (`apps/agent/irori-agent.service` + installer sed): `User=piresbruno` (installer flag `--user`, sed like the existing PATH line). No `Group=`/`SupplementaryGroups=` (db groups flow per §2). No `HOME=` env needed (systemd 255 `SetLoginEnvironment`) — but the installer asserts it post-start (`systemctl show -p User,Environment` + hello).
2. **Agent-update** (`apps/agent/src/jobs.ts`): prefix the argv with `sudo -n`; everything else identical — the root transient still owns the download/check/swap/restart, so **no `/opt/irori` chown at all**. Rollback hint path (`cp .bak`) unchanged; the `.bak` stays root-owned, hint remains an operator root action as today.
3. **Cache-user** (`modelctl.ts`): no code path change — `asCacheUser` already no-ops when `cacheUser == agentUser` (`:209`); under `User=piresbruno` + hub cacheUser `piresbruno` the wrap disappears. Add a hub-side/agent-side validation hint when a non-root agent has `cacheUser` ≠ agent user (clear `CommandBuildError`-style message). Cross-user wrap on non-root: **deferred** (would need a sudoers `runuser` rule with node-specific user baked in).
4. **Hygiene** (`hygiene.ts`): pre-check `access(W_OK)` per category; unavailable categories (crash/apport dirs) report `skipped (needs root)` instead of failed. apt/journal/docker via sudoers/group. Never raw-rm NAS (unchanged).
5. **Config default** (`config.ts:88`): `modelctlPath` default → `join(homedir(), ".local", "bin", "modelctl")` (homedir() = service user under `User=`); `IRORI_MODELCTL_PATH` override unchanged.
6. **Installer** (`install-agent.sh`): `--user` flag → sed `User=` into the unit; write the sudoers drop-in (`visudo -c` first); **preinstall `rsync`** (kills the apt path in practice); assert `id -nG $USER | grep -qw docker` with a warning (not fatal — docker hygiene self-degrades).
7. **Migration runbook (per node, ~5 min, one human sudo):**
   1. `systemctl stop irori-agent`
   2. `rsync -a /root/.local/state/irori-agent/ /home/piresbruno/.local/state/irori-agent/ && chown -R piresbruno: /home/piresbruno/.local/state/irori-agent` (keeps `setups.json` pgids + `usage-buffer.db` pending spans)
   3. re-run installer with `--user piresbruno` (new unit + sudoers)
   4. start; verify hello + snapshot; run `modelctl-install` job if `piresbruno` lacks modelctl, then `register-local` for prior root registrations; compare hub model count pre/post
   5. `chgrp docker /etc/docker/daemon.json && chmod g+w /etc/docker/daemon.json`
   6. exercise: agent-update job, hygiene audit (dry-run), one serve start (the original IR-122 repro — `HOME: unbound variable` must be gone), one `push` dry-run
8. **ADR:** new ADR superseding ADR-0003's privilege sections (root → dedicated-user-or-admin-user + sudoers boundary); ADR-0011 already lists “fleet-wide move to non-root agents” as a revisit trigger — this executes it.
9. **Server:** zero changes expected (hub is uid-agnostic; jobs/events unchanged). Verify only.

## 6. Risks / open items

- sudoers wildcard-arg matching semantics (`*` across args) — verify empirically; wrapper fallback specified.
- `piresbruno` modelctl presence per node unknown (probe at migration; `modelctl-install` job covers).
- Root-era registrations: local model registrations live in the *invoking user's* home (IR-101 note, `modelctl.ts:198-203`) — re-register under `piresbruno` or inventory silently shrinks.
- `SetLoginEnvironment` is systemd ≥254 behavior; fleet is 255 (verified) — fine; the installer assertion catches drift.
- Hygiene partial-degradation must be reflected in audit output (already per-category; add the `skipped` reason) — otherwise the hub shows failures that are policy.
- `RunOptions` timeout/env plumbing for `sudo -n` in `runStreaming`/`execFileAsync` callers: trivial, but every sudo call site needs the `-n` audit.

## Summary of findings

1. The agent's real root surface is **small and enumerable** (unit, self-update, runuser, apt/journal, two file-ownership spots) — and the headline SPEC/ADR privilege (clock/power control) is **not yet implemented**, so nothing there blocks non-root.
2. `User=piresbruno` + one sudoers drop-in covers 100% of today's root needs with **no polkit, no capabilities, no chown of /opt/irori** (the root transient self-update pattern).
3. The original serve-start `HOME: unbound variable` crash is fixed *by* the migration (systemd sets HOME for `User=` units, 255 man-verified) — no separate agent patch.
4. Constraints to accept: `cacheUser` must equal the service user (cross-user wrap deferred); hygiene crash-dir cleanup degrades to skipped; sudoers wildcard semantics get a 10-minute empirical check.
5. Rollout: migrate dgx3 first (idle), full functional matrix, then dgx1/dgx2/NAS; server untouched; ADR supersedes 0003's privilege rationale.
