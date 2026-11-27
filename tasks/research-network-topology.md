# Research: fleet network topology, live link telemetry, and link tests

Status: approved by the owner on 2026-11-27. Tickets are created in Jira (see Tracker target).

## Tracker target

- **Target:** Jira project `IR` (blastersystems.atlassian.net), with local task ids `IRI-<n>`. Local ids were renumbered on 2026-11-27 because `main` used IRI-157 and IRI-158 meanwhile.
- **How it was resolved:** the `AGENTS.md` task convention (`IRI-<number>`), plus recent commit subjects that pair both ids (`2fae4d1 … (IR-270 / IRI-156)`), plus the project memory note on Jira.
- **Tickets (created 2026-11-27, IR Sprint 6 except S7):**

| Story | Jira | Local id | Priority | Sprint |
|---|---|---|---|---|
| Epic | IR-273 | IRI-159 | Medium | IR Sprint 6 |
| S0 ADR 0021 and fixtures | IR-274 | IRI-160 | High | IR Sprint 6 |
| S1 Agent link facts | IR-275 | IRI-161 | High | IR Sprint 6 |
| S2 Topology derivation and API | IR-276 | IRI-162 | High | IR Sprint 6 |
| S3 Overview Network card | IR-277 | IRI-163 | High | IR Sprint 6 |
| S3b Opt-in live RoCE rates | IR-283 | IRI-164 | Medium | IR Sprint 6 |
| S4 Latency prober | IR-278 | IRI-165 | Medium | IR Sprint 6 |
| S5 On-demand link tests | IR-279 | IRI-166 | Medium | IR Sprint 6 |
| S6 Pushes use fabric addresses | IR-280 | IRI-167 | Medium | IR Sprint 6 |
| S7 RDMA tests and history | IR-281 | IRI-168 | Low | IR Sprint 6 (owner included it) |
| Bug: artifacts 404 under dot-dir paths (not in the epic) | IR-284 | IRI-157 | Medium | Done (fixed by #152) |

## Scope decision (owner, 2026-11-27)

**Only the RoCE fabric between Sparks is in scope.** NAS nodes and the management LAN are always outside the card, the topology and every measurement. This overrides any LAN or NAS element in the design below. Where the text still mentions the LAN, that is the push-path finding (a push that dials a LAN address), not something to draw or measure.

## Summary

Yes, most of this can be detected, and the agent already collects about half of it.

- **Already there:** every snapshot carries per-interface rx/tx rates, negotiated link speed, operstate, and addresses. Cluster membership (head plus workers) is modelled on serving setups.
- **Missing:**
  - Interface identity (MAC, driver, MTU, RDMA/RoCE capability).
  - Any record of which node is cabled to which.
  - Latency measurement.
  - An on-demand throughput test.
  - A fleet-level network view on the Overview page.

**Proposed design:**

1. The agent reports richer link facts, including its L2 neighbours.
2. The hub derives the topology by matching neighbour MACs against other nodes' interface MACs. This is a pure function in `packages/core`.
3. An Overview **Network** card draws the nodes, the links and their medium ("RoCE v2 · 200 Gb/s · MTU 9000"). Live per-link throughput comes from the existing snapshot stream, and live RTT and loss come from a lightweight agent-side ping prober.
4. A **Run test** CTA starts a hub-orchestrated iperf3 pair (server job on one node, client job on the other) and persists the result.

The design needs one new ADR, because it opens a listening port on nodes and auto-installs a package.

One finding needs attention apart from the feature: **model pushes may not travel over the CX7 fabric at all** (see Current state §4). The topology work makes this visible and checkable for the first time.

## Current state (evidence)

### 1. What the agent already collects (per snapshot, every 2 s by default)

- The per-interface byte rates come from `/proc/net/dev` deltas over the sample window (`apps/agent/src/collector.ts:744-758` and `:794-819`). `lo` is skipped; docker, veth and bridge interfaces are **not** filtered (`:803`).
- Link detail comes from `readLinkDetail` (`collector.ts:887-929`): `speedMbps` from `/sys/class/net/<if>/speed`, `operState` from `operstate`, and `addrs` from `os.networkInterfaces()`.
- The wire contract is `packages/core/src/snapshot.ts:84-98`: `{ iface, rxBps, txBps, speedMbps, operState, addrs }`. The newer fields use `.default(...)`, so older agents still parse. That is the compatibility pattern to follow.
- The default cadence is 2000 ms (`apps/server/src/config.ts:43`). The hub can change it and push it to agents through `config-update` (`apps/server/src/cadence.ts`).
- **Not collected:** MAC address (available from `os.networkInterfaces()` but discarded at `collector.ts:891-895`), driver (`/sys/class/net/<if>/device/driver`), MTU, PCI slot, RDMA device or link layer (`/sys/class/infiniband/*`), neighbour or ARP tables, and LLDP.

### 2. Where network data ends up

- **History:** the rollups **sum every interface into one number** (`apps/server/src/rollups.ts:149-150`) and store it in `net_rx_bps`/`net_tx_bps` (`packages/db/src/schema.ts:129-130`). History has no per-link detail, and fabric traffic is mixed with LAN, docker and loopback-like bridges.
- **UI:** only the node page has a Network card (`apps/web/src/components/NodeDetail.vue:1565-1581`). It shows a sparkline of the summed rate plus one line per interface: speed, state and addresses. `OverviewView.vue` has no network card (sections at `:595-836`).

### 3. Cluster membership ("workers of a cluster")

- A setup is `kind: "single" | "cluster"` with `headNodeId` plus `nodes: [{ nodeId, role: "worker" }]`, capped at 8 nodes (`packages/core/src/setups.ts:9, 32-51`).
- Node roles (`head | worker | standalone`) are derived automatically from setup membership (`packages/core/src/node.ts:102-124`, IRI-050). The server enforces that workers are real spark nodes and never the NAS (`apps/server/src/setups-service.ts:412-430`).
- So the hub **already knows** which nodes form each cluster. It doesn't know how they are connected, or whether the cluster traffic (NCCL/Ray) has a fabric path between them.

### 4. The CX7 fabric assumption in transfers

- The placement planner prefers `push` because "the CX7 fabric beats the SMB store hop" (`packages/core/src/catalog.ts:162-199`, IRI-029). `docs/SPEC.md:234` says push runs "over the CX7 fabric (… `--host` per link, round-robin)".
- **But** the push destination is the node's single registry `host` (`apps/server/src/setups-service.ts:1033`: `hosts: [cacheUser ? user@host : host]`), which is the management address the agent was registered with (`packages/core/src/node.ts:22`). Unless that hostname happens to resolve to the fabric IP, pushes run over the management LAN. Multi-link fan-out (`apps/agent/src/modelctl.ts:164`) has only ever been given one host. IRI-029 explicitly left "CX7 multi-link round-robin" out of scope.
- `[INFERENCE]` On the current fleet, pushes probably travel the 10 GbE or slower LAN rather than the 200 GbE CX7 links. Once the topology data exists, this can be checked per node (is `node.host` an address on a fabric interface?). It also gives transfers real fabric addresses to use later.

### 5. A command channel for tests

- Agent work runs as **jobs** over the WS channel (`packages/core/src/job-messages.ts:9-40`, kinds in `packages/core/src/jobs.ts:8-60`). Output streams back, and terminal status is `succeeded | failed | canceled`.
- There is precedent for **hub-orchestrated multi-node jobs** and for **auto-installing a missing package**. ADR-0014 adds `ensure-rsync` and the transfer-key jobs, which the hub sequences across source and destination.
- The agent runs as root by default (`docs/research/IRI-123-agent-non-root-research-brief.md:17`), so it can run ICMP ping, read sysfs, and install apt packages.

### 6. DGX Spark networking facts `[INFERENCE]`, verify on a node before building

- Each Spark has one ConnectX-7 with two QSFP cages, 200 GbE aggregate. Because of the GB10's PCIe layout, it appears as **four** netdevs (e.g. `enp1s0f0np0`, `enp1s0f1np1`, `enP2p1s0f0np0`, `enP2p1s0f1np1`) with matching RoCE devices under `/sys/class/infiniband/` (`rocep1s0f0`, `roceP2p1s0f0`, …).
- Spark clusters are usually direct-cabled (two nodes back to back, or a ring), or run through a 200/400 GbE switch. Addresses are usually link-local or a static /24 per cable. The netdev's link layer is Ethernet, so the "format" is **RoCE v2** when RDMA is active and plain TCP/IP Ethernet otherwise. The fleet LAN (10 GbE RJ45 or Wi-Fi) is separate.
- A single iperf3 TCP stream on the Grace CPU won't saturate 200 GbE. Expect to need `-P 4..8`, or iperf3 ≥ 3.16 (multi-threaded). The number that matters for NCCL is RDMA bandwidth (`ib_write_bw`), not TCP.

## Gap analysis

| Question asked | Possible today? | Gap |
|---|---|---|
| How are the nodes connected? | No | No MACs, no neighbours, no hub-side correlation |
| In which format? | Partly (speed only) | No driver, MTU, RDMA/RoCE or link-layer data, and no classification (fabric / LAN / virtual) |
| Which nodes are cluster workers? | Yes (setups, roles) | Never set against the physical links, so nothing flags "worker has no fabric path to head" |
| Overview card with all of this | No | New card, new API |
| Live speed per link | Data exists (per-iface rx/tx at 2 s) | Must be mapped onto edges; history is summed over all interfaces |
| Live latency | No | Needs an agent-side prober |
| CTA for latency and speed tests | No | Needs new job kinds, an iperf3 dependency, a result store and an ADR |

## Proposed design

### D1. Agent link facts (snapshot contract extension, optional fields)

Extend each `network[]` entry with optional, defaulted fields (same pattern as `snapshot.ts:91-95`):

- `mac`, `mtu`, `driver` (e.g. `mlx5_core`), `kind: "fabric" | "lan" | "virtual"`.
  - `virtual` covers `docker*`, `veth*`, `br-*`, `virbr*`, `tailscale*`, `wg*`, `tun*`, and anything without a `device/` symlink.
  - `fabric` means an RDMA device is present, or the driver is `mlx5_core` and the speed is ≥ 100 Gb/s.
- `rdma: { device, port, linkLayer: "Ethernet" | "InfiniBand", state, rateGbps } | null`, read from `/sys/class/net/<if>/device/infiniband/*` and `/sys/class/infiniband/<dev>/ports/<n>/{state,rate,link_layer}`.
- `neighbors: [{ ip, mac }]`, only for `fabric` interfaces, from `/proc/net/arp` (v4) plus `ip -j neigh show dev <if>` (v6 link-local), and only `REACHABLE`/`STALE` entries.

- `rdmaRxBps`, `rdmaTxBps` per sample, for interfaces with an RDMA device. **RoCE traffic bypasses the kernel network stack, so `/proc/net/dev` (today's rx/tx source) likely misses NCCL and other RDMA traffic** `[INFERENCE, verify in S0]`. The rates come from deltas of `/sys/class/infiniband/<dev>/ports/<n>/counters/port_xmit_data` and `port_rcv_data`. These count 4-byte units, so multiply by 4. The card shows RDMA rates for RoCE links; the netdev rx/tx stays as the TCP share (iperf3, rsync pushes).

The static facts change rarely, so read them **at most every 30 s** and cache them, the way `nvidia-smi dmon` is cached at `collector.ts:930+`. The rx/tx and RDMA counters stay per-sample. No new privileges are needed (sysfs and procfs are world-readable).

### D2. Hub topology derivation (pure, `packages/core`)

`deriveTopology(nodes, snapshots, setups) → { links, warnings }` (Sparks only; `kind: nas` nodes are excluded up front):

- **Edge:** node A's interface `ia` lists a neighbour MAC equal to node B's interface `ib` MAC. That gives the edge `{ a: {nodeId, iface}, b: {nodeId, iface}, medium, speedMbps: min(a,b), mtu: {a,b}, rdma: both? }`. It's symmetric, and an edge confirmed from both sides is marked `confirmed`.
- **Fallback when neighbours are empty** (idle link, ARP aged out): two fabric interfaces in the same non-LAN subnet form a `probable` edge. The prober (D4) then fills the ARP tables as a side effect.
- **Direct vs switched:** L2 can't prove a direct cable. If more than two nodes share one fabric subnet, show a switch pseudo-node. Otherwise report the link as point-to-point, and don't claim "direct cable" as fact.
- **Cluster overlay:** for each `cluster` setup, check that every worker has a fabric edge to the head (or a fabric path through other members). Otherwise warn: "worker X has no RoCE path to its head".
- **Other warnings:**
  - MTU mismatch across a link.
  - A link negotiated below its peer's speed.
  - A fabric interface in `down` state.
  - `node.host` isn't a fabric address. This is the push finding in §4, shown as info only.

It's pure and deterministic, so it gets full unit tests from fixtures. Expose it as `GET /api/network/topology`, computed from the latest snapshot per node. It needs no storage, because the topology is current state and rebuilds from the next snapshots.

### D3. Overview "Network" card

- **Layout:** node tiles (name, role chip) placed by cluster: the head with its workers grouped, then standalone Sparks. No NAS and no LAN. RoCE edges are solid and labelled, e.g. `RoCE v2 · 200G · MTU 9000`.
- **Edge live readout:** tx/rx from the endpoint interface's snapshot rates, plus a utilisation bar against link speed, RTT p50 and loss from D4, and the last test result with its age. Values refresh from the existing SSE snapshot stream, which needs no new transport.
- **Warnings row:** the D2 warnings.
- **CTA:** a **Test** button per edge, plus **Test all fabric links** (D5).
- It follows ADR-0018: one filled ink action per surface, so "Test all" is filled and the per-edge buttons are links. The density tiers from IRI-046 apply: on the small tier, collapse to a link table.
- `[INFERENCE]` Hand-placed SVG is enough for ≤ 8 nodes (the setup cap). A graph-layout dependency isn't justified.

### D3b. Opt-in live RoCE rates (owner, 2026-11-27)

The 2 s full snapshot is too heavy to send faster, so high-rate throughput is a separate, leased stream that the user turns on:

1. **Card:** a Live toggle with a rate picker (1 s, 500 ms, 250 ms).
2. **Browser to hub:** a REST call takes a 60 s lease, renewed while the card is visible.
3. **Hub to agents:** a new WS message `net-live { intervalMs, expiresAt }` on the existing `/agent-ws` (`apps/server/src/hub.ts:142`), sent only to Sparks with RoCE links.
4. **Agents to hub:** a small `net-rates` frame carrying the RDMA port counter deltas (D1), separate from the snapshot.
5. **Hub to browser:** a `net-rates` event on the existing SSE stream (`apps/web/src/live.ts`). It stays in memory only and never reaches the rings, rollups or the database.

**Guards:** a 250 ms floor, one shared lease for all viewers (the fastest requested rate wins), a 10-minute cap without renewal, agents stop on lease expiry or reconnect, and a `network.live.enabled` kill switch. Old agents ignore the message, and the card falls back to snapshot rates.

**Browser leg:** SSE, chosen over a dedicated browser WebSocket. SSE already pushes with no polling, and start/stop is a REST call. A browser WS would add a second unauthenticated upgrade endpoint (ADR-0002, no app auth) and more `wss://` proxy configuration.

### D4. Continuous latency (agent prober)

- For each `fabric` interface with a known peer address (an L2 neighbour, or a peer address from the hub-pushed topology), run `ping -n -q -c 5 -i 0.2 -W 1 -I <iface> <peer>` **every 10 s**. That's about 25 packets per 10 s per link, which is negligible.
- Report `{ peerIp, iface, rttMinMs, rttAvgMs, rttMaxMs, mdevMs, lossPct, at }` in a new optional snapshot field `linkProbes[]`.
- **Scope:** RoCE links only (owner decision).
- Keep it live in the rings only for now. A per-link latency history means new rollup columns. That's a later story, if wanted.
- Peer list: the agent prefers its own neighbour table, and the hub can push expected peers through `config-update` (an existing message), so idle links still get probed.

### D5. On-demand throughput and latency tests (CTA)

New job kinds, sequenced by the hub the same way ADR-0014 sequences remediation jobs:

1. `net-tool-ensure`: `apt-get install -y iperf3` when missing. Same shape and privilege as `ensure-rsync`.
2. `net-test-server` on node B: `iperf3 -s -1 -B <B fabric ip> -p <port from 5201-5210> --idle-timeout 30`.
   - It's one-shot, bound **only** to the fabric address, and the job's own timeout kills it.
   - It reports "listening" through job output, and the hub waits for that line.
3. `net-test-client` on node A: `iperf3 -c <B ip> -B <A ip> -p <port> -J -t 10 -P 4` (and `-R` for the reverse direction).
   - The JSON result goes into job output.
   - A latency burst (`ping -c 100 -i 0.01`, which needs root) runs in the same job.
4. The hub parses the JSON and persists a `network_tests` row: `{ id, a, b, ifaces, direction, gbps, retransmits, rtt p50/p99, loss, startedAt, durationMs, status, error }`. This needs a migration and a retention bound (keep the last N per link).

**Guards:**

- At most one test per link, and at most one fleet-wide "test all" running at a time, with links done sequentially.
- **Refuse by default** while either endpoint has a running push or sync job or a running cluster setup, because a 10 s saturating test would disturb live NCCL traffic. Allow an explicit "run anyway".
- Duration capped at 30 s on the server side.

**Later (optional story):** RDMA tests with `perftest` (`ib_write_bw`, `ib_send_lat`). These are closer to what NCCL sees.

### Rejected alternatives

- **LLDP (`lldpd`) as the topology source.** It gives exact port-level truth, including the switch, but needs a daemon on every node and LLDP-capable switches. Kept as an optional signal: read `lldpcli -f json` if it's present.
- **Agent-to-agent TCP echo for latency instead of ICMP.** It works without root, but needs a permanent listener on every node. Ping needs no listener, and the agent is root.
- **Speed test as a continuous background measurement.** Saturating the fabric periodically would disrupt serving. Tests must be explicit.
- **Storing the topology in Postgres.** It's current state that the next snapshots rebuild, so persisting it adds staleness bugs for no benefit. Only test results are persisted.
- **Per-interface history in the existing rollups now.** That's a schema change of its own (rollups would go from per-node to per-node-and-interface) and isn't needed for the live card. Deferred.

### ADR needed

Yes: **ADR-0021, Fleet network topology and on-demand link tests**. It's a security-sensitive, cross-cutting change:

- Job kinds that open a (bounded, one-shot, fabric-bound) listening port on nodes.
- An agent that auto-installs `iperf3`.
- A periodic agent-side ICMP prober.
- A leased, high-rate agent stream (`net-live` / `net-rates`, D3b).
- A snapshot contract extension (ADR-0006 versioning).
- A new table.

## Phased delivery plan

**Epic:** Fleet network topology and link telemetry. Stories are ordered by contract dependency and rollout safety. Effort estimates are the owner's call.

| # | Story | Priority | Depends on |
|---|---|---|---|
| S0 | ADR-0021 (Proposed), plus verifying the netdev, RDMA and neighbour layout on a real Spark | High | none |
| S1 | Agent link facts (D1) | High | S0 |
| S2 | Hub topology derivation and API (D2) | High | S1 |
| S3 | Overview Network card, read-only (D3 without CTA) | High | S2 |
| S3b | Opt-in live RoCE rates (D3b) | Medium | S1, S3, ADR 0021 |
| S4 | Live latency prober (D4) | Medium | S1 (S3 shows it) |
| S5 | On-demand iperf3 tests and CTA (D5) | Medium | S2, S3, ADR accepted |
| S6 | Push uses fabric addresses (follow-up to §4) | Medium | S2 |
| S7 | Optional: RDMA perftest, per-link history | Low | S5 |

**Acceptance criteria**

- **S0**
  - Captured `ls /sys/class/net`, `/sys/class/infiniband/*/ports/*/{link_layer,rate,state}`, `ip -j neigh`, and `ip -j addr` from at least two cabled Sparks, stored as test fixtures.
  - ADR written and indexed with status Proposed.
- **S1**
  - Snapshots carry `mac`, `mtu`, `driver`, `kind`, `rdma` and `neighbors`, and are classified correctly on the S0 fixtures.
  - Docker and veth interfaces are `virtual`.
  - Old hubs parse new agents and new hubs parse old agents (defaulted fields).
  - The static read is cached at ≥ 30 s.
  - Unit tests run on the fixtures.
- **S2**
  - `deriveTopology` yields confirmed or probable edges, the switch pseudo-node rule, and the cluster-path, MTU, speed and down-link warnings, plus the `node.host`-not-on-fabric info.
  - `GET /api/network/topology` is documented in `docs/API.md`.
  - Fixture-driven tests cover direct pair, ring, switched, missing neighbour and offline node.
- **S3**
  - The Overview card renders nodes, RoCE edges with medium, speed and MTU, cluster grouping, and warnings, with no NAS or LAN elements.
  - Live tx/rx per edge updates from SSE.
  - Handles zero-fabric fleets with an empty-state line.
  - Small-tier fallback.
  - Screenshot refreshed in `docs/screenshots/`.
- **S4**
  - Per-link RTT and loss appear in the card within about 10 s of the agent starting.
  - The probe count per link is bounded.
  - An unreachable peer reports 100 % loss and never throws.
  - Tested with injected ping output.
- **S5**
  - **Test** and **Test all** run the ensure, server and client sequence.
  - The server binds only the fabric IP, exits after one test, and is killed by timeout.
  - Results are persisted (migration with rollback notes) and shown with their age.
  - Refuses during an active transfer or cluster serve unless overridden.
  - Concurrency limit enforced.
  - Results appear in the audit trail.
  - `docs/SPEC.md` and `docs/API.md` updated.
- **S6**
  - When the topology knows a fabric address for a push destination, the push job is given that address (and both links for `--host` fan-out), falling back to `node.host`.
  - Measured throughput before and after is recorded in the task file.

**Rollout and rollback**

- S1, S2 and S4 are additive optional fields, so rolling back the agent or hub is safe.
- S5 adds a migration and a deploy-affecting agent behaviour. Name its artifact invariant and functional probe per `docs/DEPLOYMENT.md` before merge.
- A hub setting `network.tests.enabled` acts as a kill switch for S5. The prober interval is a hub setting too, and 0 disables it.

## Risks and open questions (proposed defaults in bold)

The owner accepted the defaults below on 2026-11-27. Question 1 (fleet cabling) is still open and is answered in S0.

1. **Fleet cabling:** direct cables or a switch? How many Sparks are cabled, and to whom? This decides which layouts S3 must handle well. *Default: support direct pair, ring and switched; verify in S0.*
2. **iperf3 install:** should the agent auto-install it (as `ensure-rsync` does for rsync), or should the owner install it manually? *Default: **auto-install via `net-tool-ensure`**, matching ADR-0014.*
3. **Tests during serving:** refuse while a cluster setup runs on the link? *Default: **refuse, with an explicit override**.*
4. **Latency on LAN links:** *Decided: RoCE only. NAS and LAN are always outside (owner, 2026-11-27).*
5. **History:** live-only latency and throughput in v1, or per-link history now? *Default: **live plus persisted test results**; history is S7.*
6. **Push over fabric (S6):** include it in this epic, or file it as a separate bug? The current state may mean pushes have never used CX7. *Default: **include it as S6** and measure it.*
7. **Risk:** neighbour tables age out on idle links, and only the prober (S4) keeps them warm. S2's `probable` fallback covers the gap.
8. **Risk:** TCP iperf3 understates RDMA capability. The card should label results "TCP" so nobody reads them as NCCL bandwidth.

## Mockup

Design canvas: https://claude.ai/artifact/2T62B57Ujv1XjSPhzdUu49 (private to the owner). It shows the Overview card with simulated live values, the interactive link-test dialog, and the small tier.

## Overlap findings

- **Tracker:** searched the IR project for network, CX7, latency, topology, iperf and fabric. No open overlap. Related tickets are all Done: IR-158 (link detail), IR-100 (CX7-first placement), IR-28 (placement), IR-16 (collectors).
- **Local:**
  - IRI-067 added `speedMbps`, `operState` and `addrs` (`collector.ts:883-929`). S1 extends that work rather than duplicating it.
  - IRI-029 deferred CX7 multi-link (`tasks/IRI-029-cx7-sync-source.md`, Excluded). S6 picks it up.
  - SPEC §"Hardware information" already promises "NICs incl. CX7 links" in inventory (`docs/SPEC.md:444-446`). This epic delivers that promise.
  - IRI-046 density tiers govern S3's small-tier behaviour.
