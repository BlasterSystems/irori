# feat/iri-159-network-topology (IR-273 / IRI-159)

## Business context

The Sparks talk to each other over ConnectX-7 RoCE cables: that fabric carries NCCL traffic for cluster setups and is meant to carry model pushes. Irori could not show how the nodes are cabled, in what format, or how fast the links are, so a mis-cabled node, an MTU mismatch or a push crawling over the 1 GbE LAN stayed invisible. The owner asked for an Overview card that maps the fabric live and tests it on demand.

## What changed

- **Decision recorded.** ADR 0021 covers the snapshot extension, the derived topology, the leased live stream, the listener and installer job kinds, the new tables and fabric push addressing.
- **Real evidence.** The fleet is a four-node ring, two 200 Gb/s lanes per cable, one /24 per lane. Every node's registry host is on the management LAN, so pushes have never used the fabric.

## Business rules and constraints

- Only the RoCE fabric between Sparks is in scope. The NAS and the management LAN are never drawn or measured.

## Edge cases handled

- None yet.

## Integration impact

- None yet.

## Out of scope and follow-ups

- None yet.

## Verification

- `pnpm test` and `pnpm build` green on the rebased branch before any code change.

## Changelog

- 2026-11-27 — S0 (IR-274 / IRI-160): ADR 0021 accepted and indexed; real-fleet network fixture; epic task file.
