# Research: UI feedback round 11 — empty Updates panel, silent download failures, DGX Spark forum feed, MiaAI-Lab recipes

Owner feedback, 2026-11-14, on the deployed hub (dev-0.7.0-20 lineage). Four items, verbatim:

1. [Overview screenshot] "software and firmware updates are empty" — the Updates panel shows POSTURE `UNKNOWN`, DGX OS / DRIVER `— / —` on DGX-1/2/3 and NAS.
2. "don't understand why download failed: 20:40 NAS · download-queue Inkling-2-Small-NVFP4-CSF-Flare started / failed · 1s (×2)"
3. [Community screenshot] "community isn't taking into account the posts in the DGX Spark forum with more activity in the last 3 days, https://forums.developer.nvidia.com/c/accelerated-computing/dgx-spark-gb10/"
4. "consider adding the MiaAI lab receipes for DGX Spark and monitor updates https://github.com/MiaAI-Lab?tab=repositories"

**Created 2026-11-14 (owner-approved in conversation): 4 stories appended to epic [IR-237](https://blastersystems.atlassian.net/browse/IR-237) — IR-243 (S-F updates panel), IR-244 (S-G download failure reason), IR-245 (S-H forum feed fix), IR-246 (S-I MiaAI recipes), all on sprint 1004. This doc is posted as the IR-237 epic comment (id 26032).**

**Round-12 addendum (same day, owner-approved): IR-247 (S-J cache-user truth + repair) and IR-248 (S-K feed readability + refresh dedupe) appended to IR-237 on sprint 1004. Round-12 section posted as IR-237 comment 26033; scope addenda on IR-243 (comment 26034) and IR-244 (comment 26035); the round-11 route error was corrected in the doc and in comment 26032.**

## Jira target

| Field | Value | How resolved |
|---|---|---|
| Project key | `IR` (id 10004, "Irori") | Repo convention `IRI-<n>` in AGENTS.md + mwa-jira-rest §Site 3 |
| Site host | `https://blastersystems.atlassian.net` | mwa-jira-rest §Site 3 (`JIRA_EMAIL_BLASTERSYSTEMS`/`JIRA_API_TOKEN_BLASTERSYSTEMS`) |
| Board id | **5** — "IR board", simple | Live REST probe 2026-11-14 |
| Issuetype ids | Subtask `10020`, Epic `10021`, Story `10022`, Bug `10023`, Task `10024` | createmeta (re-verified 2026-11-14) |
| Active sprint | **1004 — "IR Sprint 4"**, ends 2026-11-15T20:52Z (expires tomorrow; unfinished tasks roll over with it) | `GET /rest/agile/1.0/board/5/sprint?state=active` (2026-11-14) |
| Assignee | `<redacted-jira-account-id>` (Bruno Pires) | `GET /rest/api/3/myself` (2026-11-14) |
| Parent epic | **IR-237** "UI feedback round 10…" (To Do) — per owner instruction "add to the latest epic" | Live probe: newest epic by created DESC (created 2026-11-14T19:03Z) |
| Comment rules | Plain text only — ALL inline marks rejected (bisected IR-29) | mwa-jira-rest §Site 3 |

## Summary

- **Item 1** is not a detection bug — the agent's update-state probes are real and shipped in 0.5.0. The panel was empty because the per-node inventory rows were **stale or deleted** (DGX-1/DGX-2 rows dated 2026-11-02; DGX-3/NAS rows removed by download settles 17:47-20:42) and collection is **manual-only** — nothing re-collects periodically. (Round-12 correction: an earlier revision of this doc cited a nonexistent `/inventory` route; the route is `/api/v1/nodes/:id/models`.)
- **Item 2** is a swallowed reason: the download genuinely failed fast (modelctl preflight: `ManifestError: cannot infer a runtime: repository has no safetensors, bin, or GGUF weights` on `brandonmusic/Inkling-2-Small-NVFP4-CSF-Flare`), the precise error is in the job output, but `settleBatch` doesn't parse preflight-failure lines so every queue row gets the generic `"did not complete in the batch"`, and the Overview feed's terminal line carries no reason.
- **Item 3** is a wrong-endpoint bug: `forum:gb10-top` polls the **site-wide** weekly Top list and filters to category 719 — the live top-50 contains zero DGX-Spark topics, so the source yields ~nothing ever. It also stores topic *creation* dates, so "active in the last 3 days" is invisible to the period filter.
- **Item 4** is cheap: the recipe pipeline already has a **`miaai-script` kind** (raw `start.sh`/`stop.sh` staging) that has never been used, and community sources are one-line registry entries. It needs curated seed entries + an atom source to watch updates.

## Current state (evidence)

### Item 1 — Updates panel (data path: complete, trigger: missing)

- **Web**: `OverviewView.vue:793-811` renders the panel from `fetchUpdates()` (`api.ts:375-379` → `GET /api/v1/updates`). `refreshUpdates()` runs **once on mount** (`OverviewView.vue:414`); the 5 s/10 s/60 s timers (`:415-420`) never refresh it. NodeDetail reuses the same endpoint (`NodeDetail.vue:424-434`) and auto-tries only when `report === null` (`:516-519`).
- **Server**: `app.ts:1063-1090` — per node, `posture` starts `"unknown"` and is refined **only when `u = report.updates !== null`** (`:1076-1084`). Five postures: `update tooling absent` > `pending reboot` > `behind` > `up to date` > `unknown`. The baseline (scraped from docs.nvidia.com DGX Spark release notes, 24 h TTL cache, `updates-baseline.ts`) is **independent of node reports** — "BASELINE CACHED" can be true while every node row is empty.
- **Agent**: `apps/agent/src/updates.ts:131-160` collects kernel (`uname -r`), driver (`nvidia-smi`), `/etc/dgx-release`, `/etc/os-release`, dpkg OTA packages, `fwupdmgr get-updates --json`, `/var/run/reboot-required`, unattended-upgrades, `apt-get -s upgrade` count. Wired into `buildInventory` (`inventory.ts:501`); runs **only inside `models-inventory` jobs**. Shipped 0.5.0 (CHANGELOG "Fleet posture (IRI-081)"); all fleet agents are 0.5.x.
- **Live hub (2026-11-14 20:50)**: `/api/v1/updates` → baseline `{dgxOs 7.6.0, driver 580.178.04, kernel 7.0.0-1019, source: cache}`; all four nodes `posture=unknown, updates=null`. Per-node rows (`GET /api/v1/nodes/:id/models` — note: there is no `/inventory` route): DGX-1/DGX-2 rows dated **2026-11-02** (12 days stale, no updates block), DGX-3/NAS rows absent (deleted by download settles 17:47-20:42; `INVENTORY_MUTATING_KINDS`).
- **Invalidation trap**: any `INVENTORY_MUTATING_KINDS` job settle **deletes** the inventory row (`jobs-service.ts:626-627`) — downloads/pushes/deletes erase posture data, and with no periodic re-collection it never comes back.

### Item 2 — download-queue failure reason (ground truth from the live hub)

- The failed batch (`job f7d4e3ae`, NAS, exit 1) output tail:
  ```
  modelctl: queue preflight failed:
    entry 1 (Inkling-2-Small-NVFP4-CSF-Flare): ManifestError: cannot infer a runtime: repository has no safetensors, bin, or GGUF weights
  preflight: validating store and 1 queue entries
  ```
  The model (`brandonmusic/Inkling-2-Small-NVFP4-CSF-Flare`, exists on HF) simply has no weights modelctl can use — **the refusal is correct; the UI hides it.** A second entry `Inkling-2-Small-EXL3-4bpw` failed the same way earlier (job `09b5562f`).
- **Where the reason is lost**:
  1. `settleBatch` (`download-queue-service.ts:224-311`) parses only the `queue --json` results doc or legacy `[i/n] failed:` lines. A **preflight failure** matches neither → every row gets `"did not complete in the batch"`.
  2. The queue table shows the row error **only as a hover tooltip** (`ModelsView.vue:1412-1414`).
  3. The Overview feed's terminal line (`feedLines` `overview.ts:404-407`) renders `NAS · download-queue <name> failed · 1s` — no reason. `job-progress` frames do stream the error lines into the feed, but they are transient (cap 30, lost on reload) and the screenshot shows the owner saw only started/failed.
  4. The drawer summary (`models.ts:379`, `failed — <error>`) would show the real reason **if the row error were correct** — the fix is upstream of the UI.
- Note: `lastLine` (hub-side, `apps/web/src/jobs.ts:11`) is the *last* line = `"preflight: validating store and 1 queue entries"` — the summary line, **not** the reason. A naive lastLine append shows the wrong text.

### Item 3 — community: why the DGX Spark forum is missing

- Registry: `apps/server/src/community.ts:24-32` — `forum:gb10-top` → `forums.developer.nvidia.com/top.json?period=weekly`, parsed by `parseForumTop(body, source, 719)` (`:62-84`).
- **Root cause (verified live 2026-11-14)**: the site-wide weekly Top-50 is engagement-ranked across ALL NVIDIA forums; its `category_id`s are 740/721/632/… — **zero 719**. A GB10 topic appears only if it breaks into the site-wide top-50. `top.json` ranks by score, not recency, so even category-scoped Top misses "replied 3 days ago" topics.
- **Recency bug**: `community.ts:78` maps `publishedAt: t.created_at` — `bumped_at`/`last_posted_at` (present in the payload) are ignored. The client period filter (default `week`, `CommunityView.vue:10-13`) then drops any topic created >7 days ago even if bumped 3 h ago — exactly the owner's symptom.
- **Correct source (verified)**: `https://forums.developer.nvidia.com/c/accelerated-computing/dgx-spark-gb10/719/l/latest.json` → 200, same `topic_list.topics[]` shape `parseForumTop` already parses, sorted by `bumped_at`. `robots.txt` disallows `/t/*/*.rss` and `/c/*.rss` but **not** `.json` — poll `.json`, never `.rss`.
- Storage is generic (`community_items`, unique `(source, external_id)` — `schema-ops.ts:285-312`): **a new/changed source needs no migration and no client change** (chips derive from `community_sources` rows, `CommunityView.vue:60`).
- Gotcha: per-source `intervalMs` is dead config — every source polls every 30 min (`index.ts:420`), etag makes it cheap.

### Item 4 — MiaAI-Lab recipes + update monitoring

- `MiaAI-Lab` is a GitHub **user** (not an org — `api.github.com/orgs/MiaAI-Lab/repos` 404s; `/users/…` works, 131 public repos). Recipe-style DGX Spark repos ship **raw `start.sh`/`stop.sh`** (e.g. `GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold`, `DeepSeek-v4.1-Flash-1017-4x-DGX-Sparks-TensorFold`, `Nemotron-3.5-Bolt-TensorFold-DGX-Spark`, `sparkring`) — not sparkrun-registry YAML.
- **The pipeline already supports this**: `RECIPE_KINDS = ["miaai-script", "sparkrun-transpiled"]` (`packages/core/src/recipes.ts:23`), and `buildStageParams` (`recipes.ts`) stages `scriptStart`/`scriptStop` raw files (sha256-verified) for any non-`sparkrun-transpiled` kind. **No `miaai-script` seed entry exists** — the kind was built but never fed. `seedRecipes` unpinned entries auto-pin on boot via `pinLatestSha`.
- Seed entry shape (`recipe-seed.json`): `{slug, name, author, kind, engine, summary, upstreamUrl, commitSha, license, copyleft, defaultPort, modelRepo, envKeys, nodeCountMin/Max, scriptStart, scriptStop, provenance, startupTimeoutMs}`.
- Monitoring: community sources are one-line additions cloning the `atom:recipe-registry-commits` template (`community.ts:30`); `parseAtom` handles GitHub commit feeds as-is. `sparkdash-releases` already watches `MiaAI-Lab/sparkDash`. `atom:*` sources land in the Releases section + a chip automatically.
- Note: `recipeCatalog.behindCommits`/`engineReleasesBehind` columns exist but nothing computes/renders them yet — the atom data lands in `community_items` un-joined. Real staleness wiring is a separate story if wanted.

## Gap analysis

| # | Gap | Consequence |
|---|---|---|
| G1 | No periodic inventory/updates collection; manual Refresh only; mutating jobs delete rows | Updates panel permanently empty; posture unknown fleet-wide |
| G2 | Overview fetches `/updates` once on mount; NodeDetail auto-try only on null report | Even after a manual refresh, the panel goes stale |
| G3 | `settleBatch` doesn't parse modelctl preflight-failure output | Every preflight-failed row reads "did not complete in the batch"; the real `ManifestError` is buried in job output |
| G4 | Terminal feed line omits the failure reason; queue row error is hover-only | "don't understand why download failed" — owner's words |
| G5 | `forum:gb10-top` polls site-wide top.json → 0 category-719 topics; `publishedAt` = creation date | The DGX Spark forum never surfaces; active-but-older topics invisible to the period filter |
| G6 | `miaai-script` recipe kind unused; no MiaAI sources | Owner's preferred recipe supply is absent from the catalog and Community |

## Proposed design

**Decision: four stories appended to IR-237, all independent; no schema migrations; no agent changes.** Rejected alternatives noted per story.

- **S-F — Updates panel: periodic collection + live panel.** Server: a daily cadence tick dispatching `models-inventory` per online idle node, mirroring the weekly hygiene safe-pass pattern (`index.ts:562-589`) — reuses the existing job kind, agent wiring, one-active-per-node 409 safety (busy nodes skip; the next tick retries), and self-heals the mutating-job row deletion. Web: add `refreshUpdates()` to the Overview cards timer (`OverviewView.vue:415-420`); optionally surface report age. Rejected: on-GET dispatch from `/api/v1/updates` (side effects on GET + 409 races); a new lightweight `updates-report` job kind (new kind + agent wiring for no real gain — `apt-get -s`/`fwupdmgr` are the heavy part anyway and run once a day); agent-side cron.
- **S-G — Download failure reason surfaced end-to-end.** Server: extend `settleBatch`'s fallback to parse preflight-failure output (`modelctl: queue preflight failed:` + `entry N (name): <Type>: <message>`) → per-row `error` = the real reason (row name match is exact, same as the existing `[i/n]` fallback). Web: the Overview feed's terminal line for a failed `download-queue` job appends the matching queue row's `error` (web already holds the polled queue); make the queue-table error visible text for failed rows instead of hover-only. Rejected: appending `lastLine` (it's the summary line, not the reason); server-side SSE payload changes (wire churn for a client-side lookup).
- **S-H — Forum source: category-scoped latest + activity dates.** Server: `community.ts:25` URL → `…/dgx-spark-gb10/719/l/latest.json`; `parseForumTop` keeps the 719 filter (belt-and-braces) and maps `publishedAt: bumped_at ?? created_at` (`community.ts:78`). Update the fixture test (`community-ir83.test.ts:19-25`) and `docs/API.md:442-452`. No DB/client change; the period filter immediately reflects last activity. Rejected: keeping a separate "top" source (Top+latest both useful later, but one source per concern; chips stay clean); scraping HTML (Discourse JSON is first-class).
- **S-I — MiaAI-Lab recipes + update watch.** Add `miaai-script` seed entries for a curated repo set (each with `upstreamUrl: https://github.com/MiaAI-Lab/<repo>`, `scriptStart: start.sh`, `scriptStop: stop.sh`, engine `tensorfold`/`other`, modelRepo/defaultPort curated per repo) + one `atom:miaai-*` community source per seeded repo's commit feed (clone of `recipe-registry-commits`). Zero pipeline work — the kind and staging path exist. Rejected: watching the whole user feed `github.com/MiaAI-Lab.atom` (one line, but ~50 HTML-gallery repos would flood the Releases list); writing sparkrun YAML wrappers (the repos already ship start/stop scripts; transpilation would lose their multi-node/TP specifics); computing `behindCommits` (separate story).

## Phased delivery plan (stories under IR-237)

Order: S-G (owner is actively blocked on understanding failures) → S-H (small, high visibility) → S-F → S-I (curation at the gate). All four are independent; no DB migrations anywhere.

- **S-F (Task) — Updates panel populated: daily inventory sweep + panel refresh.** AC: within 24 h of deploy, `/api/v1/updates` reports a non-unknown posture, DGX OS (7.6.x) and driver (580.x) for every online DGX node, with the cached baseline chip; the Overview panel refreshes on the cards timer without reload; a mutating job (download/push/delete) invalidating a row self-heals by the next daily tick; NAS row shows a probe-derived posture (`update tooling absent` if no apt — not hardcoded); string pins updated; light+dark verified.
- **S-G (Bug) — Download failures say why.** AC: a preflight-failing download (repro: `brandonmusic/Inkling-2-Small-NVFP4-CSF-Flare`) leaves queue rows with `error = "ManifestError: cannot infer a runtime: …"` (visible in the queue table without hover and in the drawer summary line); the Overview feed's terminal line appends the reason (truncated to one line); a mid-batch partial failure still uses the results-doc path unchanged; unit test pinned to the real preflight output shape from job `f7d4e3ae`.
- **S-H (Bug) — Community surfaces the DGX Spark forum.** AC: the Latest list includes category-719 topics active in the last 3 days (verified against `l/latest.json`); the period filter uses last-activity dates; a topic created 2026-11-04 but bumped 2026-11-14 renders under `week`; existing sources unaffected; fixture test + docs/API.md updated.
- **S-I (Task, scope fixed at gate) — MiaAI-Lab recipes in the catalog + commit watch.** AC: seeded recipes appear in the recipe catalog with `miaai-script` kind, auto-pinned SHAs, and install → stage (sha256) → wizard-start works on a spark node; each seeded repo has a community chip showing commit activity in Releases; docs/API.md recipes section updated. Gate inputs: which repos, and per-repo atoms vs. a curated aggregate.

Effort estimates: owner's call (none fabricated).

## Risks & open questions

1. Sprint 1004 ends 2026-11-15 — tasks assigned there roll over with the sprint (same note as round 10).
2. **S-I repo curation is a gate decision** — candidates observed (all with start/stop scripts, active ≤2 weeks): `GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold`, `GLM-5.3-Flash-EXL3-2x-DGX-Sparks`, `GLM-5.3-Flash-4x…switchless`, `DeepSeek-v4.1-Flash-1017-4x-DGX-Sparks-TensorFold`, `DeepSeek-v4.1-Flash-DGX-Sparks`, `Nemotron-3.5-Bolt-TensorFold-DGX-Spark`, `Qwen3.8-Flash-Next-Dual-DGX-Sparks`, `sparkring`. Each needs curated `modelRepo`/`defaultPort`; a wrong `start.sh` contract surfaces via the wizard + IR-151 demotion, not silently.
3. Raw-script recipes run third-party shell as root on nodes — same trust model as any recipe (sha256-staged, wizard-confirmed); flag in the entry summary.
4. S-F's daily `models-inventory` adds NAS store scans (78 models) — once a day, one node at a time; acceptable, but the tick must skip busy nodes rather than queue behind transfers.
5. `bumped_at`-as-`publishedAt` is a semantic change to an existing column — existing rows keep old values until re-upserted (30-min poll); acceptable, no migration.
6. `intervalMs` dead-config gotcha stands — new sources inherit the 30-min poll; fine (etag).
7. Item 2's second failure (`0xSero/Inkling-2-Small-EXL3-4bpw`) is now explained: job `09b5562f` was a **2-entry batch** and entry 2 (the NVFP4-CSF-Flare repo) failed manifest preflight, aborting the whole batch — entry 1 never ran and was also marked "did not complete in the batch" (see Round 12, F5).

## Jira overlap findings (searched 2026-11-14, REST `search/jql`)

- No open ticket covers updates/posture (search: `posture`, `firmware`, `driver version`, summary `updates` → 0), community/forum/recipe (summary searches → 0), or download-failure UX (`text ~ download` → only IR-224 epic, unrelated).
- IR-237's current children IR-238..242 (round-10 items) all To Do — the four new stories append cleanly.
- Prior art: IRI-081 (fleet posture, shipped 0.5.0, no task file), IR-174/IRI-083 (community, `community-ir83.test.ts` header), IRI-082 (recipe catalog/transpiler), IRI-017/IRI-026/IRI-141 (download queue lineage). No duplication.

---

# Round 12 (owner follow-up, 2026-11-14 21:14) — delete-local, feed JSON flood, batch preflight

Owner message, verbatim context: the two repos `brandonmusic/Inkling-2-Small-NVFP4-CSF-Flare` and `0xSero/Inkling-2-Small-EXL3-4bpw`, then the feed excerpt:

```
21:14 DGX-3 · delete-local GLM-5.3-Flash-EXL3-4bpw started
21:14 DGX-3 · delete-local GLM-5.3-Flash-EXL3-4bpw: error: delete-local: unknown local cache user "operator"
21:14 DGX-3 · delete-local GLM-5.3-Flash-EXL3-4bpw failed · 0s
21:15 DGX-3 · models-inventory started
21:15 DGX-3 · models-inventory: {"generatedAtMs":…,"store":{…13 KB of JSON…},"updates":{…}}
21:15 DGX-3 · models-inventory succeeded · 5s
(×2, back-to-back)
```

"another issue to add to the latest epic" → appended to IR-237 as S-J/S-K, with scope addenda on IR-243/IR-244.

## Correction to round 11 (recorded 2026-11-14 21:22)

The round-11 probe used `GET /api/v1/nodes/:id/inventory`, which **does not exist** (the route is `/api/v1/nodes/:id/models`). The true state, re-probed: DGX-1/DGX-2 rows dated **2026-11-02** (12 days stale, `updates:null`); DGX-3 row absent until the 21:15 job; NAS absent. So the panel was empty because rows were **stale or deleted**, not because no row ever existed anywhere. S-F's daily sweep remains the correct fix and additionally repairs the stale-row case; the S-F acceptance criteria are unchanged.

## Findings (all verified live unless marked)

### F1 — delete-local: "unknown local cache user" for a user the hub already knows has no modelctl

- Job `d1a4bdbf` (DGX-3, failed in 28 ms): params `{name:"GLM-5.3-Flash-EXL3-4bpw", user:"operator"}`; output `error: delete-local: unknown local cache user "operator"`.
- Error origin: `apps/agent/src/modelctl.ts:479-480` (delete-local branch; the same message exists for `sync-local` `:325` and `register-local` `:506`).
- Resolution rule: `resolveLocalUser` (`apps/agent/src/inventory.ts:105-114`) requires a **per-user modelctl binary** (`localBinary(home)`); missing binary → `null` → the "unknown" message. The user IS in `/etc/passwd` — the inventory report lists `operator` with `modelctlVersion: null` and `error: "modelctl is not installed for this user"`. **The hub knew the real condition and still printed "unknown".**
- An actionable wording already exists: `asCacheUser` (`modelctl.ts:193-210`, IR-101) says `no modelctl for cache user "X" — install it for that user (sudo -u X uv tool install "modelctl") or clear the node's cache user setting`. The three per-user job branches never adopted it.
- **Repair gap**: `autoProvisionModelctl` (`apps/server/src/jobs-service.ts:109-126`, IR-105) dispatches `modelctl-install` only when `modelctlVersion` is a semver below the pin — `version === null` is skipped (`continue`), so a *missing* modelctl is never auto-installed even though `modelctl-install {user}` supports exactly that (`modelctl.ts` modelctl-install branch, IR-105).
- **The binary existed days earlier**: job `ae3fd981` (DGX-3, 2026-11-11 14:41) ran `modelctl-install {user: operator}` and skipped with "modelctl 0.24.0 satisfies the 0.24.0 gate". No `models-inventory` ran between 2026-11-11 and 21:14, so the clicked row came from **stale client state**; the agent re-resolves at dispatch (TOCTOU). The table only renders when `cache.error === null` (`NodeDetail.vue:1140-1143`), so the action looked valid on the stale report.
- **The discriminator already exists**: `resolveCacheHome` (`inventory.ts:120-130`, passwd home only) distinguishes "no passwd entry" (really unknown) from "no modelctl" — the three job branches can re-check it to pick the right message. Also: no per-user install action exists in the UI (`JOB_VERBS`, `apps/web/src/models.ts:436-446`, is unused by components).
- UI gate: the web builds `{kind:"delete-local", params:{name, user}}` from a local row (`apps/web/src/inventory.ts:81-82`) without consulting the cache entry's `error`/`modelctlVersion` — the action is offered although the target user cannot be resolved.

### F2 — Activity feed floods with the raw inventory report; duplicate dispatches

- The models-inventory report is emitted as the job's **final output line** (agent runner; the JSON is 11,624 bytes — measured from jobs `df875af4`/`c42ddbe3`) and rendered verbatim by `feedLines` (`apps/web/src/overview.ts:415-421`, `job-progress` case). One line floods the feed; two jobs flood it twice.
- Duplicate dispatch is real: audit shows **two `node.models-refresh` entries** for DGX-3 (jobs 21:15:02 and 21:15:22, both succeeded). Trigger sites: NodeDetail auto-try when `report === null` (`NodeDetail.vue:516-519`) + the manual Refresh/Read-models buttons (`NodeDetail.vue:1040,1054,1066`) via `refreshNodeInventory` (`apps/web/src/inventory.ts:39-43`). No freshness guard; the server's one-active-per-node guard only prevents *overlap*, not repeats after the first read settles.
- Feed caps are 120 (Overview, `OverviewView.vue:382`) and 200 (TelemetryDrawer, `:60`) — the 30-line default in `feedLines` is unused — so the harm is one unreadable 13 KB line plus one evicted event per job; the same raw line also shows in the node sheet's last-line bar (`NodeDetail.vue:620,1214`) and the job sheet's `pre` (`:1475`). Every product-report kind dumps JSON the same way (recipe-install, hygiene-audit/clean, staging-tree-audit, quarantine-prune, nas-delete-batch).
- Duplicate dispatch: the **only** creation site is `POST /nodes/:id/models/refresh` (`app.ts:1183-1205`). POST #1 (21:15:02) was the NodeDetail auto-try — the failed delete-local settle deleted `node_inventory`, so the page saw `report === null` and auto-refreshed (`NodeDetail.vue:516-519`). POST #2 (21:15:22, 19.7 s later) must be a manual Refresh or a second tab — the auto-try flag allows only one automatic POST per visit. The route has **no freshness guard**: `jobs.create` enforces one-active-per-node only (`jobs-service.ts:343,360`) and never consults `inventory.get(id).updatedAt`.

### F3 — `dgxOsVersion` parses to `DGX_NAME="DGX Spark"` (seen in the pasted report)

- Live DGX-3 report: `dgxOsVersion: "DGX_NAME=\"DGX Spark\""` (should be a version like `7.6.0`). `readDgxOsVersion` (`apps/agent/src/updates.ts:53-64`) applies `/^(?:DGX_OS|VERSION)?[=\s]*(.+)$/m` — on a `/etc/dgx-release` whose first non-empty line is `DGX_NAME="DGX Spark"` the optional group and `[=\s]*` match empty and `(.+)` captures the **whole line**. There is no explicit version key (`DGX_SWBUILD_VERSION`/`DGX_OTA_VERSION`), so any file shape that doesn't start with a bare version parses to garbage.
- Consequence: `/api/v1/updates` now shows DGX-3 `posture=behind`, `dgxOs=DGX_NAME="DGX Spark"` — a permanent false mismatch against baseline `7.6.0`. Blocker for S-F's acceptance criteria.

### F4 — posture noise: any upgradable apt package keeps every node "behind"

- DGX-3's fresh report carries `upgradableCount: 125` (Ubuntu 24.04.5 with no reboot pending, OTA packages current, driver 580.178.04 = baseline). The `behind` predicate includes `upgradableCount > 0` (`app.ts:1076-1084`), so even after F3 is fixed every node reads **behind** forever — alarm fatigue on the exact panel the owner asked to populate. Decision needed: DGX OS posture should consider dgxOs/driver/OTA/firmware; `upgradableCount` should be informational (shown, not verdict-bearing).

### F5 — one invalid batch entry aborts the valid ones

- Job `09b5562f` was a **2-entry** batch: entry 2 (`brandonmusic/Inkling-2-Small-NVFP4-CSF-Flare`) failed manifest preflight (`ManifestError: cannot infer a runtime: repository has no safetensors, bin, or GGUF weights`); modelctl's preflight validates the whole queue, so entry 1 (`0xSero/Inkling-2-Small-EXL3-4bpw`, a real EXL3 repo) **never ran** and its row was also marked "did not complete in the batch". A single bad entry blocks good ones.

## Proposed tickets

- **S-J (Bug) — Cache-user truth: honest error + automatic repair.** (a) delete-local/sync-local/register-local use the IR-101 actionable wording (name the user, the remedy, the install command); (b) `autoProvisionModelctl` also dispatches `modelctl-install {user}` when `modelctlVersion === null` (missing, not just below pin); (c) the web annotates/gates local-cache delete actions when the cache entry carries `error` or `modelctlVersion === null`, offering install instead. AC: repro on DGX-3/operator → the delete either self-heals (install job then delete) or fails with the actionable message; a null-version user gets a `modelctl-install` dispatched after the next inventory; after install, delete-local succeeds; inventory UI shows the per-user state.
- **S-K (Bug) — Feed stays readable: payload lines summarized, refreshes deduped.** (a) `feedLines` renders job-progress lines that are payload JSON (starts with `{` or > 400 chars) as a short summary (`models-inventory: report received · 11.6 KB`) instead of the raw line; (b) a manual inventory refresh within ~60 s of a successful read reuses the cached report (no new job), and the auto-try respects that guard; (c) the Models/NodeDetail surfaces show "read 15 s ago" so a second click isn't invited. AC: one summarized line per inventory job, zero raw JSON in the feed, no back-to-back dispatches on double-click/revisit; other job kinds' feed lines unchanged.

## Scope addenda on round-11 tickets (comments, not new tickets)

- **IR-243 (S-F)**: F3 (parser) and F4 (posture predicate) are prerequisites for S-F's "DGX OS 7.6.x / non-unknown posture" acceptance criteria — S-F must include both, plus the corrected evidence (stale 2026-11-02 rows on DGX-1/2, absent rows on DGX-3/NAS) and the fact that a fresh read already exists at 21:15 (proof the agent half works).
- **IR-244 (S-G)**: F5 extends the story from "say why" to "don't let one bad entry kill a batch" — per-entry isolation (pre-validate each entry, or dispatch single-entry batches on preflight failure) and per-entry error attribution for the aborted entries.

## Risks & open questions

1. F2's dedupe window is a UX choice (60 s suggested); the server route has no ETag-like freshness contract today.
2. F4 changes posture semantics — any dashboards/tests pinning `behind` on `upgradableCount` need updating (`routes-ir84.test.ts` matrix).
3. F5 fix may be modelctl-side (preflight is modelctl's) — hub-side mitigation is split-and-retry; decide with the modelctl pin cadence.
4. F1's auto-install on null version runs `modelctl-install` with `{user}` — the job needs network + uv on the node; failures must surface (they will, as job output).
5. Sprint 1004 ends 2026-11-15 — same rollover note.
