# ADR-0012: Register-from-cache without transfer

- **Status:** Accepted
- **Date:** 2026-10-27
- **Decision owners:** Bruno Pires
- **Scope:** Model supply chain, agent job surface, models inventory report, node-page UI
- **Tags:** modelctl, hf-cache, jobs, inventory, security
- **Supersedes:** None
- **Superseded by:** None

## Context

Modelctl state is per user and registrations are written only by validated
pipelines (`sync-local`, `push` → `receive-cache`, `download`). Content that
arrived by other means — a manually moved `models--*` dir, a plain
hf-cli download, a hand copy — is invisible: the Local cache card lists
registrations, not directories. The previously available registration paths
all re-transfer the object (on 2026-10-26 a 164 GiB `sync-local` re-read the
whole object from the NAS into staging even though the bytes were already on
disk), which is pure waste when the local copy is already correct, and
staging transiently doubles the disk usage.

## Decision drivers

- Registration must never certify bytes that were not verified against the
  store's canonical object — the record is what delete, placement, and the
  card trust.
- The fleet's links to the NAS are slow relative to local NVMe; re-copying
  present content is unacceptable for moved models.
- The agent is privileged: any new job kind must not widen what a hub request
  can execute beyond one more `modelctl` verb with fixed arguments.

## Considered options

### Option 1 — full `sync-local` re-sync

Always correct, but re-copies everything (staging + publish), doubles disk
transiently, and burns the NAS link for content already present.

### Option 2 — hand-edit modelctl state

No validation, breaks on schema change, and poisons the state modelctl
itself relies on. Rejected outright.

### Option 3 — modelctl `register-local` (verify-then-register), adopted

modelctl 0.23 `register-local` resolves the active store object, locates the
local cache entry, and verifies it **without transfer**: LFS blobs are
checked by blob-identity (the sha256 is the filename) plus size; non-LFS
files by content hash on both sides; the file set and snapshot commit must
match. Any mismatch refuses with a per-file report and writes nothing.
Passing verification reuses the same publish/register internals as
`sync-local`, so the resulting state is byte-identical to a full sync.
Irori maps this to a `register-local` job that runs as the cache user (the
IRI-028/ADR-0011 pattern), reports unregistered `models--*` dirs as
derivable repo ids in the models inventory, and offers a Register action on
the node page.

## Decision

Option 3. Registration without transfer is allowed exclusively through
`modelctl register-local`, which fails closed on any verification mismatch.
Irori never writes modelctl state directly. The agent's `register-local` job
builds one fixed argv (`modelctl register-local <name> --source-root
<nasRoot>`, wrapped `runuser` as the cache user when one is set); the hub
never sends paths. The models inventory carries an `orphans` list per local
cache (defaulted empty so pre-0.23 reports and old cached rows parse), and
the UI's Register confirm states that verification is read-only and nothing
is transferred.

## Consequences

### Positive

- Moved or hand-downloaded models become managed in seconds of hashing
  instead of a bulk re-copy (observed: 164 GiB verified with 45.62 KiB read).
- The registration is exactly as trustworthy as a full sync — same internals.
- Orphan visibility is generic: any future "where did this cache entry go"
  question is answered by the card.

### Negative

- The cache user needs modelctl >= 0.23; older binaries fail the job with
  modelctl's own `invalid choice` error (the pin default rises to 0.23.0).
- Nodes without a `nasRoot` cannot register (nothing to verify against) —
  the job fails fast by design.

### Risks and mitigations

- *Verification gap*: blob-identity checks trust the filename-to-hash
  mapping; modelctl additionally checks sizes, and small files are hashed.
  A corrupted blob with a matching name and size but different content is
  outside this threat model (the store itself uses the same identity rule).
- *Stale orphans*: the orphan list is computed at inventory time; a stale
  card can offer a Register for something just registered. The job is
  idempotent and the settle drops the cached inventory.

## Implementation and validation

- Agent argv + inventory orphans: unit tests in `apps/agent`
  (`m4.test.ts` argv, `inventory.test.ts` orphan detection).
- Server settle (upsert node-model row + inventory invalidation):
  `apps/server/test/job-events.test.ts`.
- Web confirm copy: `apps/web/test/inventory.test.ts`.
- Live precedent: DGX-2, 2026-10-27 — dry-run verified 94 files (86 by blob
  identity, 8 content-hashed, 45.62 KiB), then registered with no transfer.

## Revisit triggers

- modelctl changes its state schema or verification internals.
- Orphan detection needs to cover caches outside `~/.cache/huggingface/hub`
  (custom `--cache-dir` installs).

## References

- IR-104 / IRI-033 task record (`tasks/IRI-033-register-local-cache.md`)
- IRI-028 research brief §3.6 (recovery options for a CIFS-denied delete)
- ADR-0004 (modelctl as supply-chain engine), ADR-0011 (per-user cache ops)
