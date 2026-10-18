# IRI-006 research brief — serving orchestration: script conventions, supervision, staged transfers

- **Date:** 2026-10-18
- **Ticket:** IRI-006 (M5) — Jira [IR-29](https://blastersystems.atlassian.net/browse/IR-29)
- **Goal:** What do the real start/stop scripts look like on the existing
  cluster, how do workers get their ranks/ports, and what does Irori need to
  supervise, stream, and stage?

## 1. The live cluster (verified 2026-10-18 over SSH on dgx-1 / 10.20.30.4)

- **Fleet:** 3 DGX Sparks — `dgx1` = 10.20.30.4 (**head**, TP rank 0), workers
  `10.20.30.5` and `10.20.30.6` (MAC `38:a7:46:5a:1a:*` / `38:a7:46:98:a7:*`
  matched on the mgmt LAN). 10.20.30.5/6 are **not SSH-reachable** from dgx1 or
  the Proxmox host (publickey denied) — workers are provisioned out-of-band.
- **Engine:** `tensorfold serve` **rank 0 in a Docker container**
  `glm53-flash-tf` (image `tensorfold-glm53:v0.6.0`, built from
  `ghcr.io/miaai-lab/glm-5.3-flash-exl3-2x-dgx-sparks-tensorfold`):
  `tensorfold serve /root/.cache/huggingface/hub/models--brandonmusic--GLM-5.3-Flash-tr3-4bpw/snapshots/…`
  `--tp 3 --rank 0 --master 10.20.30.4 --master-port 29551 --name GLM-5.3-Flash-EXL3
  --host 0.0.0.0 --port 8081 --drafter …/models--incoai--GLM-5.3-Flash-DFlash2/snapshots/…
  --context 1048576 --parallel 8 --max-tokens 32768 --thinking --vision
  --spill-gib 32 …`
- **Ranks rendezvous on `--master 10.20.30.4:29551`**: `ss -tnp` shows the
  master port held by rank 0 with ESTAB peers from the two CX7 networks
  (`10.40.40.3↔.2`, `10.40.40.4↔.1` = the workers over their CX7 links).
  Each host owns **two CX7 NICs (4 ports total, 10.40.40-45.x /24s)**;
  RoCE is on all four (`TF_ROCE_HCA=rocep1s0f0,…`), NCCL socket NIC is the
  mgmt port (`NCCL_SOCKET_IFNAME=enP7s7`).
- **Ports:** engine HTTP = `--port 8081` (serving, `--host 0.0.0.0`); master
  rendezvous = `--master-port 29551`. Both live in the start command —
  **scripts own ports/config**; Irori only learns the serving port from the
  wizard and probes it.
- **Model source:** the HF-cache path
  (`/root/.cache/huggingface/hub/models--…snapshots/<sha>`) — exactly what
  `modelctl path --local NAME` resolves (SPEC §7 MODEL_PATH export).
  The drafter (`--drafter`, MTP/DFlash companion) is a second cache path.
- **No script pair exists yet** — the current setup is hand-launched
  `docker run` (no compose labels). M5 introduces the script pair; the
  observed convention for one that manages this container:
  start = `POST /containers/glm53-flash-tf/start` over
  `/var/run/docker.sock` + `logs?follow=1` for streamed output; stop =
  `POST /containers/…/stop`. The **irori agent container has no docker CLI
  and no docker.sock mounted** (verified) — scripts using the socket need the
  bind added to the agent container (homelab install choice; the agent is
  privileged by design, ADR-0003).
- **Container env is the engine's config surface** (`TF_GLM_*`, `NCCL_*`,
  `TF_ROCE_*` ~35 vars) — scripts that recreate containers must carry it; the
  existing container keeps it, so start/stop scripts that only start/stop are
  enough for v1.

## 2. Supervision model (SPEC §7 + ADR-0003)

- Irori launches **one script pair on the head**: start + stop, both
  `test -x` validated at create and re-checked at every start. Stop is
  **required** (launch refused without one); fallback when the stop script
  fails: kill the recorded process group (the agent spawns the start script
  detached with its own pgid and records pid+pgid).
- **Detached drivers survive server restarts**: the engine is a child of the
  agent's process group, not of the server connection; the agent persists
  driver state (pid, pgid, log path, started-at) in its node-local state dir
  and re-attaches (alive probe via `kill(-pgid,0)`) on boot/reconnect.
- **Logs:** the start script's stdout+stderr is the engine log — appended to
  a per-run file on the node, kept in a bounded agent ring, streamed as
  `setup-log` frames (seq + line), replayable by lastSeq.
- **Health:** the node's existing LLM probe watches the script-defined port
  (the server injects it into the node's `llmPorts` on create). Healthy =
  probe reports a model id containing the setup's model name; a *different*
  model on that port = **foreign**; nothing past the startup timeout
  (15 m, wizard review step) = failed.

## 3. Staged transfers (SPEC §7, reusing M4 pieces)

- Stages per missing node, chained server-side from the placement planner:
  HF→NAS (`download-queue` on the NAS node) → NAS→node (`sync-local` on the
  target, which mounts the NAS) → node→node (`push` **run on the source**
  node — modelctl push reads the local cache registration).
- **Progress:** modelctl shells out to `rsync --info=progress2
  --human-readable` (verified in `modelctl/src/modelctl/remote.py:374-384`),
  so the job output carries lines like
  ` 1,234,567,890   45%  234.56MB/s    0:03:12` **separated by `\r`, not
  `\n`** — the agent's line splitter must split on `\r` as well, and the
  parser is: bytes, percent, rate, eta from the last progress chunk.
  With `--jobs ≥ 2` modelctl prints completion lines instead of per-stream
  progress (verified docstring, `cli.py` sync section) — parser treats
  missing progress as 0% until completion lines arrive.
- **Cancel:** each stage is a normal M4 job (SIGTERM process group);
  the wizard's cancel cancels the running stage and stops the chain.
- **Warnings never block** (busy node, capacity tight): the planner already
  keeps push sources on capacity/offline failures (M4) — the staged engine
  surfaces them the same way.

## 4. Agent container facts (e2e relevant, dgx1)

- Agent container `irori:agent-arm64` (built 2026-10-18 from this repo's
  `docker/Dockerfile` agent role) mounts `/mnt/nas` (the NAS store root) and
  the HF cache volume (`HF_HOME=/home/deploy/.cache/huggingface`); it points
  at the Mac dev server (`IRORI_SERVER_URL=ws://10.20.30.79:3947/agent-ws`).
- `modelctl` 0.20.1 is provisioned inside the container at
  `/root/.local/bin/modelctl` (`IRORI_MODELCTL_PATH`), pin
  `IRORI_MODELCTL_PIN=0.20.1`.
- No `/var/run/docker.sock`, no `docker` CLI (verified) — see §1 for the
  script implication.

## Summary of findings

- The script-pair contract is exactly SPEC §7: head-owned scripts, ports in
  the scripts, stop required, process-group fallback; Irori never edits them.
- Workers are reachable only via the master rendezvous — Irori supervises the
  head and watches per-node LLM probes; per-worker state comes from agent
  online + model presence, not from inside the worker containers.
- Staged-transfer progress is rsync progress2 over `\r` — parse + throttle on
  the server; stages are plain M4 jobs, so the transfer engine is a thin
  chaining layer over the existing jobs subsystem.
