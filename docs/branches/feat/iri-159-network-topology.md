# feat/iri-159-network-topology (IR-273 / IRI-159)

## Business context

The Sparks talk to each other over ConnectX-7 RoCE cables: that fabric carries NCCL traffic for cluster setups and is meant to carry model pushes. Irori could not show how the nodes are cabled, in what format, or how fast the links are, so a mis-cabled node, an MTU mismatch or a push crawling over the 1 GbE LAN stayed invisible. The owner asked for an Overview card that maps the fabric live and tests it on demand.

## What changed

- **Decision recorded.** ADR 0021 covers the snapshot extension, the derived topology, the leased live stream, the listener and installer job kinds, the new tables and fabric push addressing.
- **Real evidence.** The fleet is a four-node ring, two 200 Gb/s lanes per cable, one /24 per lane. Every node's registry host is on the management LAN, so pushes have never used the fabric.
- **Agents report link facts.** Every interface now carries its MAC, MTU, driver, classification (fabric, LAN or virtual), addresses with prefix, the bound RoCE port (device, state, rate), complete IPv4 neighbours on fabric links, and RDMA byte rates. RoCE traffic bypasses the kernel counters, so the RDMA rates are what show NCCL traffic.
- **The hub derives the topology.** `GET /api/v1/network/topology` groups fabric lanes into links per node pair, recognises switched subnets, checks every cluster's fabric path to its head, and warns on MTU and speed mismatches, down lanes, offline nodes, and registry hosts that are not on the fabric. It works with today's agents too: an old snapshot's 200 Gb/s non-virtual ports count as fabric.
- **Overview Network card.** A diagram of the Sparks in cable order with each link's format (RoCE v2, speed × lanes, MTU) and live ↑/↓ throughput, a link table with utilisation bars, switched subnets, running clusters with their fabric-path check, and the warnings. On the small tier the table is the whole view. The NAS and the LAN never appear.
- **Live latency per link.** Agents ping every fabric peer (their ARP neighbours plus the far end of each lane, which the hub pushes) every 10 s and report RTT and loss in the snapshot; the card shows the worst up lane per link. The interval is a hub setting (`/api/v1/settings/network`, 0 turns it off), next to the kill switches for tests and live mode.
- **Opt-in live mode.** A Live toggle on the card streams fabric rates at 1 s, 500 ms or 250 ms. The browser holds a 60 s lease it renews while visible; every viewer shares one stream at the fastest requested rate. Rates travel agent → hub → browser over the existing WebSocket and SSE and are never stored.

## Business rules and constraints

- Only the RoCE fabric between Sparks is in scope. The NAS and the management LAN are never drawn or measured.
- A direct cable is never claimed as fact: point-to-point lanes are links; a subnet shared by three or more nodes is drawn as a switch.
- The prober only pings out of fabric interfaces, at most 16 peers, with validated interface names and IPv4 literals and no shell.
- Live mode: 250 ms floor, a lease ends after 10 minutes (the card says so and stops), agents stop on their own when the hub stops renewing or the socket drops, and `liveEnabled` turns it off for everyone.

## Edge cases handled

- Interfaces without sysfs (macOS dev boxes), a docker bridge or tailscale with a MAC, an incomplete ARP entry, and an RDMA counter that goes backwards (reported as unknown, never as a negative rate).
- A fleet with no fabric links shows an empty-state line; an unavailable or malformed topology shows a one-line error instead of breaking the Overview; offline nodes keep their tile, drawn dashed, without links.
- An unreachable peer, or a ping that cannot start, reports 100 % loss instead of failing; peers that vanish from the topology drop out of the results; a config-update never carries an invalid peer, so an old or strict agent never rejects the whole frame.
- A hidden tab lets its lease lapse and silently takes a new one when it comes back; an old agent ignores `net-live` and the card falls back to snapshot rates; a frame that stops arriving goes stale on screen after three intervals.

## Integration impact

- Snapshot contract: new optional, defaulted fields (ADR-0006). Old hubs strip them; new hubs fill defaults for old agents.

## Out of scope and follow-ups

- None yet.

## Verification

- `pnpm test` and `pnpm build` green on the rebased branch before any code change.

## Changelog

- 2026-11-27 — S3b (IR-283 / IRI-164): leased live RoCE rates over SSE.
- 2026-11-27 — S4 (IR-278 / IRI-165): fabric latency prober, network settings.
- 2026-11-27 — S3 (IR-277 / IRI-163): Overview Network card with live throughput.
- 2026-11-27 — S2 (IR-276 / IRI-162): topology derivation and the topology API.
- 2026-11-27 — S1 (IR-275 / IRI-161): agent link facts and RDMA rates in the snapshot.
- 2026-11-27 — S0 (IR-274 / IRI-160): ADR 0021 accepted and indexed; real-fleet network fixture; epic task file.
