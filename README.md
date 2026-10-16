# Irori

**A BlasterSystems product.**

AI fleet platform for NVIDIA DGX Spark (GB10) homelabs: inference management,
first-class telemetry, benchmarks, and a NAS-backed model supply chain.

- One **server container** (Express 5 + Vue 3) runs on any computer in the
  LAN — not necessarily a Spark.
- One **privileged agent** per node (root systemd service, outbound
  WebSocket): clocks, hardware info, model sync (NAS ↔ nodes, CX7 fan-out),
  realtime inference monitoring, serving supervision.
- One **NAS node** acting as the central LLM repository, fully compatible with
  the [`modelctl`](../modelctl) store layout — no migration, ever.
- Cluster serving from **user-owned recipes**: NAS → head → workers, cluster
  start/stop scripts supervised with logs streamed into telemetry.
- **Benchmarks**: decode, prefill, quality, tool-eval. **Analytics**: memory,
  decode, power, tokens — grouped or separated, per cluster or per node.
- Homelab trust model: no application auth; SSH credentials and agent tokens
  encrypted at rest (AES-256-GCM).

Replaces `sparkDash`, `sparkControl`, `modelctl`-as-dashboard-glue, and
`sparkLimiter` with a single narrowed system. See
[docs/SPEC.md](docs/SPEC.md).

## Status

**M0 — governance** (spec, ADR-0001…0006, plan, process). Implementation
starts at [M1](docs/PLAN.md).

## Documentation

| Doc | Content |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Authoritative product & technical spec |
| [docs/PLAN.md](docs/PLAN.md) | Epic milestones M0–M7, exits, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Component map, data, deployment |
| [docs/adr/README.md](docs/adr/README.md) | Architecture decision records |
| [docs/DEVELOPMENT_PROCESS.md](docs/DEVELOPMENT_PROCESS.md) | Workflow + skills |

## Validation

```bash
.agentic/bin/validate
.agentic/bin/docs-check
```

(Build/test commands arrive with M1: `pnpm build`, `pnpm test`, `pnpm dev`.)

---

A BlasterSystems product — thread mark ○—■, Fira Sans, DM Mono.
