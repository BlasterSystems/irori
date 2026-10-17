# Irori

**A BlasterSystems product.**

Irori is an AI fleet platform for **NVIDIA DGX Spark (GB10) homelabs**: one
server container that manages your Sparks for inference, a privileged agent on
every node, a NAS-backed model supply chain, first-class telemetry,
benchmarks, and analytics. It replaces a dashboard, a CLI wrapper, a clock
script, and a folder of scripts with a single, coherent system.

- One **server container** (Express 5 + Vue 3) that runs on any computer in
  the LAN — not necessarily a Spark.
- One **privileged agent** per node (root systemd service, outbound
  WebSocket): CPU/GPU underclocking, hardware telemetry, model sync
  (NAS → head → workers over ConnectX-7), realtime inference monitoring,
  serving supervision, and disk hygiene.
- One **NAS node** acting as the central LLM repository, fully compatible
  with the [`modelctl`](https://github.com/piresbruno/modelctl) store layout —
  nothing on the NAS ever migrates.
- Cluster serving from a **wizard**: model + nodes + your start/stop scripts,
  with placement checks and staged transfers.
- **Benchmarks** (decode, prefill, quality, tool-eval) and an **Analytics**
  section (memory, decode, power, temps, tokens — grouped or separated, per
  cluster or per node).
- Homelab trust model: **no application auth**; SSH credentials and agent
  tokens encrypted at rest (AES-256-GCM).

```
○ — ■   The circle is what you can see. The square is on record.
```

## Goals

1. **Inference first.** The head node's serving state is the primary object of
   the UI: serving model, decode/prefill throughput, queue, cache. Workers
   show the essentials only (memory, CPU/GPU usage + temperature, package
   power).
2. **One command to run.** `docker compose up` on any LAN computer; no
   external database dependency for a happy path (Postgres on your own
   Proxmox host), no inbound ports on nodes.
3. **NAS as the source of truth.** Search, download, and delete models on the
   NAS; Sparks pull from the NAS — never re-downloading from the internet
   what is already home — then fan out to workers over the fastest fabric.
4. **No sudo dances.** The agent runs privileged by design; clock control,
   sysfs, and modelctl are ordinary code paths.
5. **Telemetry you can trust.** Collection is independent of any browser,
   snapshots are versioned contracts, retention is bounded, and analytics
   read precomputed rollups.
6. **Honesty.** Power is labeled *estimated, not wall-metered*; destructive
   operations are dry-run first and armed explicitly; the protected set is
   printed inside every confirmation.

## Expectations

Irori is a **single-operator homelab tool**, not a multi-tenant service.
What you can expect from the project:

- **Docs-first development.** The [spec](docs/SPEC.md) is authoritative;
  decisions are recorded as [ADRs](docs/adr/README.md) before implementation;
  milestones ([PLAN](docs/PLAN.md)) are vertically sliced and each ships
  something usable.
- **Validation gates on every change**: `pnpm test`, `pnpm build`,
  `.agentic/bin/validate`, `.agentic/bin/docs-check`, plus a live smoke of the
  changed path.
- **Mobile-respectful UI**: every screen must work at 390 px without
  horizontal overflow — the fleet is checked from a phone as often as from a
  desk.
- **No feature creep toward dashboard parity**: ComfyUI/Hermes/Tailscale
  monitoring, alerting, PWAs, and request tracing are explicitly out of v1
  ([non-goals](docs/SPEC.md#1-goals)).

Status and milestones: **[docs/PLAN.md](docs/PLAN.md)** — M0 governance is
complete; implementation starts at M1 (walking skeleton). Screen mockups live
in [`mockups/`](mockups/index.html) and are the approved UI reference.

## Design guidelines

Irori's UI follows the **BlasterSystems design system** (oracle:
`Design System.dc.html` in the design-system repo) — the same visual language
as every BlasterSystems product:

- **Ink or paper only.** Text and surfaces use the ink/paper ramp; the
  thread vermilion (`--thread`) is the *only* accent — it marks the live
  pulse, the active chart line, and warn/error states. It is never a fill,
  a background, or a second accent.
- **One filled button per screen.** Primary actions are ink-filled; danger is
  a vermilion *outline*, never a fill.
- **States are shapes first**: ○ open circle = running/pending, ■ filled
  square = recorded/healthy, ◆ rotated diamond = held/warn, ▫ hollow square =
  stopped/cancelled. Color never carries a state alone.
- **Data is DM Mono** (12–13 px, right-aligned numbers, uppercase letter-
  spaced labels); interface copy is Fira Sans. No shadows; 2 px controls,
  4 px panels; charts have no SVG text — all labels are HTML.
- **Tokens are the API**: colors are the DS token set baked to sRGB hex
  (light + dark, three-block theme mechanism, OS-preference aware); spacing
  uses the 4 px base scale; radii are literal 2/4 px.
- **Mobile-first verification**: layouts are verified at 390 px (no
  horizontal overflow, 44 px touch targets, drawers become full-bleed
  sheets, tables scroll with a sticky first column).

## Documentation

| Doc | Content |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Authoritative product & technical spec |
| [docs/PLAN.md](docs/PLAN.md) | Epic milestones M0–M7, exits, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Component map, data, deployment |
| [docs/adr/README.md](docs/adr/README.md) | Architecture decision records |
| [docs/DEVELOPMENT_PROCESS.md](docs/DEVELOPMENT_PROCESS.md) | Workflow + skills |
| [mockups/index.html](mockups/index.html) | Approved screen mockups |

## Inspiration & credits

Irori is built from scratch and does not copy or fork any codebase —
nevertheless, it is built on top of ideas and products from:

- **[sparkDash](https://github.com/MiaAI-Lab/sparkDash)** —
  [MiaAI-Lab](https://github.com/MiaAI-Lab), Mia's AI Lab — the multi-unit
  DGX Spark monitoring dashboard that started this line of work. Irori's
  fleet information architecture, benchmark suite, and LLM probing approach
  descend from it.
- **[sparkLimiter](https://github.com/MiaAI-Lab/sparkLimiter)** —
  [MiaAI-Lab](https://github.com/MiaAI-Lab) — GPU clock capping with
  boot-time persistence. Irori reimplements the logic natively in its
  privileged agent (adding CPU caps; persistence via reconnect-reconcile
  instead of a systemd unit) and uses no code from it. Discovery
  hardening by [@danielkuykendall23-boop](https://github.com/danielkuykendall23-boop).
- **C. Michael Gibbs** — [MikeGibbsOnyx](https://github.com/MikeGibbsOnyx) —
  and **Nyx Voss** (Onyx AI Labs) — the macOS (darwin) SSH collectors in
  sparkDash, whose unit-collector pattern Irori's agent generalizes.
- **[agentic-bootstrap](https://github.com/piresbruno/agentic-bootstrap)** —
  the provider-neutral project bootstrap tool that generated this
  repository's scaffold (workspace layout, agent instructions, validation
  gates) via `agentic-bootstrap init --platform all`; the generated
  configuration is maintained per
  [docs/AGENT_GUIDED.md](docs/AGENT_GUIDED.md).

Irori replaces and absorbs the maintainer's own predecessor projects — see
**Dependencies** below for the one that lives on.

## Dependencies

The notable runtime dependencies (everything else is standard: Node 24 +
pnpm, Docker, rsync):

- **[modelctl](https://github.com/piresbruno/modelctl)** — the model supply
  chain engine. The agent provisions it per node (pinned GitHub release via
  `uv tool install`, wheel fallback bundled offline) and drives every NAS
  store mutation through it; catalog reads use the `catalog.json` contract
  and never require it
  ([ADR-0004](docs/adr/0004-modelctl-as-supply-chain-engine.md)).
- **PostgreSQL 16+** on your own infrastructure (default target: a Proxmox
  host) via `DATABASE_URL` — [ADR-0002](docs/adr/0002-postgresql-on-proxmox-storage.md).

## Validation

```bash
.agentic/bin/validate
.agentic/bin/docs-check
```

Build/test/run commands arrive with M1: `pnpm build`, `pnpm test`,
`pnpm dev` (pnpm/TypeScript monorepo — `apps/server`, `apps/web`,
`apps/agent`, `packages/core`, `packages/db`).

## License

[Apache-2.0](LICENSE). Irori is a BlasterSystems product — the thread mark
and the "A BlasterSystems product" endorsement follow the design system's
brand rules.
