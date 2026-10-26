# ADR-0011: Per-node cache user for model transfers

- **Status:** Accepted
- **Date:** 2026-10-26
- **Decision owners:** Bruno Pires
- **Scope:** Model supply chain (sync-local, push), node registry schema, agent command surface, node UI
- **Tags:** modelctl, hf-cache, runuser, transfers, security, jobs
- **Supersedes:** None
- **Superseded by:** None

## Context

Model transfers publish models into the HF cache of **whoever runs modelctl**.
The Irori agent runs as root, so `sync-local` (default destination
`HF_HUB_CACHE` → `~/.cache/huggingface/hub`) and the root side of `push`
published every model into `/root/.cache/huggingface/hub`. The owner checked
their user's cache and found nothing (IR-101): two 163.6 GiB sync-local jobs
succeeded and published to `/root/.cache/huggingface/hub/models--…`.

Moving the model with `--cache-dir` is not a fix: modelctl's local
registration state lives in the **invoking user's** state dir
(`$XDG_STATE_HOME|~/.local/state/modelctl/…`, keyed by cache dir), so a root
invocation pointing at a user path splits registration state across homes and
the user's own modelctl never sees the model. IRI-028 already established the
per-user cache reality and shipped the resolution + `runuser` machinery for
`delete-local` and the per-node models inventory.

## Decision drivers

- Models must land where the owner's tooling reads them: the owner's HF cache.
- Registration state must stay in one user's home (no split brain).
- The agent is privileged (ADR-0003) — the new surface must not widen the
  command injection or path-injection risk.
- modelctl stays the only transfer engine (ADR-0004).

## Considered options

### Option 1: Auto-resolve the cache owner per transfer

The agent scans local HF caches (IRI-028 `discoverUsers`) and runs transfers
as the first owner found. No UI or schema change; but implicit — surprising on
multi-user nodes, and a fresh node (no cache yet) silently falls back to root,
recreating the gap.

### Option 2: Explicit per-node cache user (chosen)

`nodes.cache_user` (validated POSIX username, nullable). The agent runs
`sync-local` and the push source side via `runuser -u <user>` with a scrubbed
env (`HOME`, `XDG_STATE_HOME`, `HF_HOME`, `HF_HUB_CACHE`) and the **user's
own modelctl binary**, resolved agent-side via `/etc/passwd`
(IRI-028 `resolveLocalUser`). Push destinations are addressed as
`user@host`, composed by the server (staged transfers) and the web drawer
from the destination node's setting, so the remote receive lands in the same
user's cache. Unset — or equal to the agent user — keeps today's root
behavior.

### Option 3: Keep root and document

No code change; the owner's cache never receives models. Rejected by the
owner.

## Decision

Option 2. A missing user modelctl fails the job with an actionable error; it
never silently falls back to root's cache. `download`/`download-queue` are
unchanged — they write the NAS **store** (root/modelctl-owned), not an HF
cache. `delete-local` already resolves per user (IRI-028) and is untouched.

Operating prerequisites (owner ops, one per node): the cache user needs a
modelctl install (`uv tool install`), and passwordless **user-level** ssh
between sparks for `push` (root-to-root keys exist today; user keys are
separate).

## Consequences

### Positive

- Models land in the owner's HF cache with registration state in one place.
- The setting is explicit and visible in the node UI.
- No NAS store changes; downloads, deletes, hygiene unchanged.

### Negative

- One more node field to configure.
- `push` between cache-user nodes requires user-level ssh keys and user
  modelctl installs.

### Risks and mitigations

- Command injection through the user name — mitigated: strict username
  pattern (`^[A-Za-z_][A-Za-z0-9_-]{0,31}$`) validated at the API, and the
  value is interpolated only into a `runuser` **argv** (no shell).
- Path injection — none: the hub sends only the user name; home/binary are
  resolved agent-side from `/etc/passwd` (IRI-028).
- Missing prerequisites fail jobs — surfaced with actionable job errors.

## Implementation and validation

Migration `0018_add-cache-user.sql`; hub `config-update` carries `cacheUser`;
agent `buildCommand` wraps `sync-local`/`push` (`asCacheUser`); setups staging
and the model drawer compose `user@host`. Validated by unit tests (agent argv,
core schemas, setups composition, db store), plus a live smoke: a real
`sync-local` on a node with a cache user publishing into that user's HF cache.

## Revisit triggers

- Multi-user nodes needing per-model or per-group cache ownership.
- modelctl gaining server-side cache-dir + state redirection (would obsolete
  the runuser dance).
- Fleet-wide move to non-root agents (ADR-0003 revisit).

## References

- IR-101 / IRI-030, tasks/IRI-030-cache-user-transfers.md
- ADR-0003 (privileged agent), ADR-0004 (modelctl engine), ADR-0009 (NAS-first
  downloads), IRI-028 (per-user cache inventory)
