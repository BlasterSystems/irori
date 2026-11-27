# ADR-0021: Fleet network topology, live link telemetry and on-demand link tests

- **Status:** Accepted
- **Date:** 2026-11-27
- **Decision owners:** Bruno Pires
- **Scope:** Agent snapshot contract (`network[]`, `linkProbes[]`), agent WS protocol (`net-live` / `net-rates`), job kinds that open listeners and install packages, hub topology derivation, `network_tests` and `network_link_minutes` tables, push destination addressing
- **Tags:** network, rdma, roce, telemetry, agent, jobs, security, schema, transfers
- **Supersedes:** None
- **Superseded by:** None

## Context

The fleet's Sparks are cabled to each other through their ConnectX-7 cards. The
hub knew which nodes form a cluster setup, but not how they are wired, in what
format, or how fast the links are. The research brief
(`tasks/research-network-topology.md`, epic IR-273 / IRI-159) lays out the gap.

Evidence captured from the dev hub on 2026-11-27 (agent 0.7.0 snapshots, stored
as `packages/core/test/fixtures/network-fleet-2026-11-27.json`):

- Four Sparks, cabled as a **ring**: DGX-1↔DGX-2, DGX-2↔DGX-3, DGX-3↔DGX-4,
  DGX-4↔DGX-1. Each cable shows up as **two** 200 Gb/s netdevs per side
  (`enp1s0f*np*` and `enP2p1s0f*np*`, the two PCIe halves of one cage), each on
  its own point-to-point /24 (`10.100.112.0/24` … `10.100.119.0/24`).
- Every node's registry `host` is a management-LAN name or address (10.0.10.x).
  Model pushes dial `node.host`, so they have never used the fabric.
- The NAS and the management LAN are out of scope by owner decision.

Capturing `/sys/class/infiniband` and neighbour tables directly was not
possible from the workstation (no SSH access to the nodes). The agent now
reports them, so the deployed fleet produces that evidence itself.

## Decision drivers

- Show RoCE topology, link format and live throughput/latency without new
  daemons or switches that speak LLDP.
- Keep the agent contract backward compatible (ADR-0006 versioning).
- Tests that saturate a link must be explicit, bounded and refusable.
- Nothing may open a general-purpose listener or install arbitrary packages.
- High-rate telemetry must never reach the database by accident.

## Considered options

### Option 1: LLDP (`lldpd`) on every node

Exact port-level truth, including switches. Needs a daemon on every node and
LLDP-capable switches; the ring has no switch at all. Rejected as the primary
source; `lldpcli` output may be read later if present.

### Option 2: Agent link facts plus hub-side derivation (chosen)

The agent reports MAC, MTU, driver, interface kind, RDMA device state, IPv4
neighbours and CIDRs. A pure function in `packages/core` derives links by
neighbour MAC (confirmed) or shared point-to-point subnet (probable).

### Option 3: Continuous background speed tests

Saturating links periodically would disturb NCCL traffic and serving. Rejected:
throughput tests are on demand only.

### Option 4: A dedicated browser WebSocket for high-rate rates

A second unauthenticated upgrade endpoint (ADR-0002, no app auth) plus more
`wss://` proxy configuration. Rejected in favour of the existing SSE stream.

## Decision

1. **Snapshot extension (optional, defaulted fields).** Each `network[]` entry
   gains `mac`, `mtu`, `driver`, `kind` (`fabric | lan | virtual`), `cidrs`,
   `rdma` (`device, port, linkLayer, state, rateGbps`), `neighbors` (IPv4 from
   `/proc/net/arp`, complete entries only) and `rdmaRxBps` / `rdmaTxBps`
   (deltas of `port_rcv_data` / `port_xmit_data` × 4). Static facts are cached
   for 30 s. A new optional top-level `linkProbes[]` carries prober results.
   Old hubs strip the fields; new hubs default them for old agents.
2. **Topology is derived, never stored.** `deriveTopology()` in
   `packages/core/src/network.ts` builds links (lanes grouped per node pair),
   switch pseudo-nodes for subnets shared by more than two nodes, the cluster
   overlay and warnings. `GET /api/v1/network/topology` computes it from the
   latest snapshot per node. The NAS is excluded up front.
3. **Latency prober.** The agent pings each fabric peer (its neighbours plus
   hub-pushed expected peers from `config-update.netPeers`) with
   `ping -n -q -c 5 -i 0.2 -W 1 -I <iface> <ip>` every `netProbeIntervalS`
   (default 10 s, 0 disables, at most 16 peers). `execFile`, no shell; the
   interface and address are validated before spawn.
4. **Opt-in live rates (leased).** The browser takes a 60 s lease with
   `POST /api/v1/network/live` and renews it while the card is visible. The hub
   sends `net-live {intervalMs, durationMs}` (floor 250 ms; `durationMs` is
   relative, so clock skew cannot extend it) to Sparks with fabric interfaces.
   Agents answer with `net-rates` frames, stop when `durationMs` elapses or the
   socket closes, and never buffer them. The hub forwards them as a
   `net-rates` SSE event that is excluded from the event feed and journal and
   never touches rings, rollups or the database. One shared stream serves all
   viewers (the fastest requested interval wins).
5. **On-demand tests as jobs (ADR-0014 pattern).**
   - `net-tool-ensure`: installs `iperf3` and `perftest` with apt when
     missing. It takes **no params**, so it cannot become an arbitrary-install
     surface.
   - `net-test-server`: runs `iperf3 -s -1` bound to an address the agent
     verifies is on one of its own **fabric** interfaces, on a port in
     5201–5210, for a fixed number of one-shot runs, under a hard timeout of
     at most 120 s. For `tool: "rdma"` it runs one `ib_write_bw` and one
     `ib_send_lat` server on the fabric port's RoCE v2 GID (ports
     18515–18524). perftest has no server bind option, so its one-shot TCP
     rendezvous socket listens on all addresses for at most that timeout;
     the RDMA traffic itself stays on the fabric port.
   - `net-test-client`: runs the matching client from a local fabric address
     to a target that must be in the same fabric subnet, at most 30 s per
     direction and 1–8 streams, then a 100-packet latency burst. It reports
     one `IRORI_NET_RESULT=` JSON line.
   - The hub (`apps/server/src/network-tests.ts`) sequences ensure → server →
     wait for `IRORI_NET_LISTENING` → client, cancels the server job when the
     client settles, and persists the result in `network_tests` (last 50 per
     node pair). Guards: one test per link, one fleet-wide "test all" at a
     time, refusal while either endpoint runs a cluster setup or a transfer
     unless the caller passes `override: true`, and the one-active-job-per-node
     slot.
6. **Pushes use the fabric when it is direct.** When the topology has a direct
   link between source and destination, the push job's `hosts` lists the
   destination's fabric address of every up lane (modelctl `--host` fan-out);
   otherwise it keeps `node.host`. Push remediation (ADR-0014) resolves a
   fabric address back to its node and pins the host key per address.
7. **Per-link history.** The hub folds snapshot rates and probe results into
   one-minute rows per link (`network_link_minutes`), kept for 7 days.
8. **Kill switches.** The `network` settings row carries `testsEnabled`,
   `liveEnabled` and `probeIntervalS` (`GET`/`PUT /api/v1/settings/network`).

## Consequences

### Positive

- The cabling, its format and every cluster's fabric path are visible and
  checked continuously, with warnings for MTU and speed mismatches, down lanes,
  clusters without a fabric path, and pushes that bypass the fabric.
- Pushes between directly cabled Sparks move to the 200 GbE fabric.
- No new daemon, no permanent listener, no new browser transport.

### Negative

- Two job kinds open a short-lived listener, and one installs two packages.
- The snapshot grows by roughly 1 KB per Spark (four fabric netdevs).
- TCP iperf3 understates RDMA capability; results are labelled TCP or RDMA.

### Risks and mitigations

- *A test disturbs NCCL traffic.* Refused during cluster serving or transfers
  unless overridden, capped at 30 s per direction, and never scheduled.
- *A listener is reachable from the LAN.* The iperf3 listener binds only a
  verified fabric address; perftest's rendezvous socket cannot be bound, so
  it is one-shot and killed by the same timeout (at most 120 s, typically
  about 25 s). Both serve a fixed number of clients.
- *The client is used to flood an arbitrary host.* The target must be inside
  the client's own fabric subnet; params are validated agent-side.
- *Neighbour tables age out on idle links.* Subnet matching covers the gap
  (probable lanes), and the prober keeps ARP warm.
- *RDMA counters behave differently on another firmware.* Rates are null when a
  counter is missing or goes backwards; the card falls back to netdev rates.

## Implementation and validation

Delivered by IR-274…IR-281 and IR-283 (IRI-160…IRI-168) on one branch.
Validation: fixture-driven unit tests for collection, classification, topology
(ring, pair, switched, missing neighbour, offline node), ping/iperf3/perftest
parsing and param validation; DB tests for test persistence and history; a
dev deploy with the topology API and the card checked against the real ring.

## Revisit triggers

- A switch is added to the fabric (switched layouts become the common case).
- NCCL bandwidth numbers are needed in the card (perftest becomes the default).
- App authentication is introduced (the lease and test routes need roles).
- The 2 s snapshot is replaced by a delta protocol.

## References

- `tasks/research-network-topology.md`, `tasks/IR-273.md`
- ADR-0002, ADR-0003, ADR-0006, ADR-0011, ADR-0014
