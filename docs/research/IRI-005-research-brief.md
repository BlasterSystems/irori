# IRI-005 research brief — modelctl command surface, store facts, jobs mapping

- **Date:** 2026-10-18
- **Ticket:** IRI-005 (M4) — Jira [IR-24](https://blastersystems.atlassian.net/browse/IR-24)
- **Goal:** What exactly does Irori call, read, and build for the model supply chain?

## 1. The real store (verified 2026-10-18 over SSH on dgx-1 / 10.0.10.4)

- NAS: **QNAP ARM** (`nas.as267.com`), share `//nas.as267.com/llms`; dgx-1 mounts it
  via `/etc/fstab`: `//nas.as267.com/llms /mnt/nas cifs credentials=/etc/.smbcredentials,iocharset=utf8,uid=1000,gid=1000,mfsymlinks,nofail,x-systemd.automount 0 0`
  (17 T share, 11 T used; `mfsymlinks` = the CIFS symlink support `queue`/`download`
  preflight requires).
- **Store root = `/mnt/nas`** (the share root itself). `/mnt/nas/llm-models/` is a
  stale, empty schema-2 store (2026-09-05) — ignore it. No `python3`/`uv`/`modelctl`
  on the NAS or dgx-1 → **modelctl provisioning (uv → pinned release) is required**
  on model-ops nodes (ADR-0004 install job); the NAS only hosts files.
- Live inventory: **127 active models** (schema 3, `generation` 10, `seq` 5,
  generated 2026-10-03), `models/` = 800 GB, orgs incl. `0xSero`, `unsloth`,
  `deepseek-ai`, `z-lab`, `incoai`. `state/NAME.json` journals ✓, `cards/NAME` ✓,
  `manifests/NAME.yaml` ✓ (safetensors + GGUF shapes confirmed).

## 2. Command surface (modelctl v0.20.1, `piresbruno/modelctl`)

| Verb | Use in Irori | Key flags |
|---|---|---|
| `list [--json] [--root R]` / `list --local` | NAS catalog cross-check; local HF registrations | `--json` = same projection as catalog `models[]` |
| `download SRC [--name --revision --quantization --runtime --mmproj --mtp --force --root]` | NAS download job (form-built YAML preferred → `queue`) | dry preflight, resumable staging, atomic publish+activate |
| `queue FILE [--jobs N --root]` | NAS download job from form-built YAML (exactly one `downloads:` key; unknown fields rejected) | full preflight before any transfer; per-entry results; `mfsymlinks` validated |
| `manifest SRC …` | not v1 (queue covers it) | |
| `update NAME` | not v1 | |
| `path NAME [--root/--local]` | surfaced copy-only (ADR-0004: never executed) | |
| `serve-command NAME` | surfaced copy-only | adds `--mmproj`/MTP args from companions |
| `sync-local NAME|repo [--queue --jobs --source-root --cache-dir]` | NAS→node job | resumable, ETag-validated, publishes HF cache layout |
| `push NAME --host H [--host H2 … --jobs N --cache-dir --remote-modelctl]` | node→node CX7 fan-out job | repeated `--host` = round-robin streams; dest needs modelctl+rsync; `receive-cache --probe` handshake |
| `delete NAME [--root]` | NAS delete job — **dry-run first, then `--apply --yes`** | removes active ref → catalog refresh → journals/staging/objects; never touches local cache |
| `delete-local NAME` | node cache cleanup job (NAS untouched) | |
| `doctor [--json --root]` | hygiene popover | valid/foreign/broken/invalid/journal-mismatch/repairable-dirs |
| `repair-active [NAME] [--apply --root]` | armed repair (dry-run first) | quarantine + verified symlink |
| `cleanup-staging` / `gc-objects` / `cleanup-quarantine` `[OBJ] [--apply]` | armed hygiene (exact 3-part paths from audit) | refuses live/resumable data |
| `staging-audit` / `objects-audit [--json]` | hygiene popover content | |
| `catalog status|refresh|path [--root]` | catalog stale → armed refresh | `refresh --force` allows empty store |
| `sync-cards [NAME…] [--force]` | cards backfill job | |
| `receive-cache --probe NAME` / `receive-cache NAME --staging P` | remote half of push (agent-invoked on destination) | |

Token cost: `download`/`sync-local`/`push` print resumable progress; job output
ring keeps last N lines. Exit codes: 0 ok; nonzero = any entry failed (queue
continues). `--yes` required for non-interactive `--apply`.

## 3. Catalog contract (schema 3 — read-only for Irori, ADR-0004)

```json
{ "schema": 3, "generation": 10, "generated_at": "…+00:00",
  "active_fingerprint": "…", "content_sha256": "…", "seq": 5,
  "models": [ { "name", "runtime": "vllm|llama.cpp", "repository", "bytes" } ] }
```

- Reader rules: trust only while `schema == 3`; else → live scan + warning.
  Missing/invalid/dirty/`seq` behind the store counter → live scan of `active/`
  (name → manifest parse) with a warning; listings never rewrite the catalog.
- Live scan needs `active/NAME` → manifest (`name/repo/revision/format/runtime/
  include/companions`) → object dir; the **agent** owns fs access (packages/core
  ships the types + validators; the scan runs in the agent).

## 4. Provisioning (ADR-0004 install job)

1. `uv --version` — missing → `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. `uv tool install --force piresbruno/modelctl` (pinned GitHub release tag; the
   release wheel ships in the agent bundle as offline fallback → `uv tool
   install --force <bundled.whl>`)
3. `modelctl --version` ≥ pin; else fail with actionable output.
4. `modelctl config set-root <nasRoot>` on model-ops nodes.

## 5. Jobs mapping (SPEC §13; one active per node, 409 otherwise)

Job kinds → commands: `modelctl-install` (provisioning), `download-queue`
(form-built YAML → temp file → `queue --jobs N`), `download` (store → node HF
cache by owner/model id; writes the local active registration push requires),
`sync-local`, `push`
(`--host` ×CX7 links `--jobs N`), `nas-delete` (dry-run job then armed
`--apply --yes` job), `delete-local`, `doctor --json`, `repair-active`
(dry-run/armed), `staging-audit`, `objects-audit`, `cleanup-staging`/`gc-objects`
(armed, exact paths), `catalog-refresh`, `sync-cards`. Output = streamed CLI
text into the job output ring; cancel = SIGTERM process group.

## 6. Placement planner (packages/core, pure)

`model × node → present | sync | push | unavailable`
- node has catalog entry / local registration → present.
- node is model-ops with the NAS root mounted & catalog contains it → sync.
- node is a spark/gpu-host reachable & source node registered → push (CX7 hosts listed).
- capacity math: free = diskFree − reserve (agent-reported); needs = bytes (catalog or local); ok iff `free ≥ needs + reserve`.

## Summary of findings

- Store facts verified live; golden fixture `catalog.json` (127 models) captured
  at `apps/agent/test/fixtures/catalog.json` + real manifest
  `DeepSeek-V4-Flash-0731-EXL3-3.0bpw.yaml`.
- Irori = orchestrator: core reader/planner + agent wrappers/jobs + server APIs
  + Models v2 UI; modelctl does all store mutations.
