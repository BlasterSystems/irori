# IRI-025 research brief — Overview feedback round 3 (range filter, power chart + cost, tokens, settings UX)

- **Date:** 2026-10-25
- **Ticket:** IRI-025 (stories IR-90..IR-95 under epic IR-89)
- **Goal:** the implementation depends on which history ranges/buckets exist, where fleet power and token-usage series come from, how cost settings persist, and what the queue/download/connection surfaces expose. Approved design: `mockups/overview-v3.html` (commits 4de2de3, a0ff33e, 644dcad).

## 1. Range filter: 30m (default) · 1h · 4h · 24h · week · month

Evidence:

- `apps/server/src/history.ts:6` — `HISTORY_RANGES = ["30m", "1h", "24h", "7d", "30d", "90d"]`; `RANGE_GRANULARITY` (`:22-28`): 30m/1h → minute, 24h/7d/30d → hour, 90d → day. **"4h" is the only missing range**; week/month are UI labels for the existing 7d/30d wire values.
- `apps/server/src/config.ts:24-26` — retention defaults: minute buckets kept 7 days, hour 90, day 365 → every requested range is covered by existing buckets; no retention change.
- `packages/core/src/analytics.ts:19` — `ANALYTICS_RANGES = ["1h", "24h", "7d", "30d", "90d"]`; `analyticsGranularity` (`:30-41`): **1h already maps to minute**; 24h/7d → hour; 30d/90d → day. Add "30m" (minute) and "4h" (minute) for the power/tokens cards.
- Both hero-chart consumers already parametrize the range: `apps/web/src/components/OverviewView.vue` `refreshCharts()` calls `fetchLlmHistory(nodeId, "30m")` (hardcoded) and `refreshCards()` calls `fetchAnalytics("power", "1h", "node")` — both accept a range argument today.

Decision: add `"4h"` to `HISTORY_RANGES` (minute granularity) and `"30m"`/`"4h"` to `ANALYTICS_RANGES` (minute). The UI filter shows labels `30m · 1h · 4h · 24h · week · month` and maps week→`7d`, month→`30d`.

## 2. Power bar chart (fleet total, NAS excluded, envelope line)

Evidence:

- `apps/server/src/history.ts:47` — `HistoryPoint.gpuPowerW` (avg summed-across-cards GPU watts per bucket) served by `GET /api/v1/nodes/:id/history?range=`.
- `packages/db/src/schema.ts:104,111` — `snapshot_buckets.package_power_w` + `gpu_power_w`; `apps/server/src/rollups.ts:28` — per snapshot the gpus array is folded (power = sum across cards).
- `packages/core/src/analytics.ts:127-128` — `GB10_SYSTEM_ENVELOPE_W = 240` (per-node clamp), `DEFAULT_BASE_OVERHEAD_W = 40`.
- `apps/web/src/overview.ts:126-141` — `computePower()` already scans per-node analytics series for the latest `watts`; the analytics **power lens points carry `watts` per bucket** (`foldCluster` sums `watts/gpuW/cpuW/baseW`, `analytics.ts:255-262`).
- `apps/web/src/components/OverviewView.vue` `refreshCards()` — already fetches `fetchAnalytics("power", "1h", "node")` every 60 s.

Decision: no new endpoint. The Overview fetches the power lens with `groupBy=node` for the selected range and sums the **spark** nodes' `watts` per bucket client-side (NAS series has no watts — its nodes are excluded by `kind !== "nas"` via `live.sortedNodes`). Energy = Σ(bucketW × bucketDuration) using the response's `granularity`; cost = kWh × price. The bar chart is a small pure renderer (SVG rects) + a 240 W envelope reference line; per-bucket details live in an ⓘ tooltip, not visible captions.

## 3. Tokens card (input / cached / output + cost preview)

Evidence:

- `packages/db/src/schema.ts:393-417` — `token_ledger(node_id, port, model, granularity, bucket_start, generated_tokens, prompt_tokens, cached_tokens, *_seen)`; schema comment: **`cached` is a subset of `prompt`** (prefix-cache hits).
- `apps/server/src/ledger.ts:113-118` — the ledger engine writes **only `hour` and `day` rows** (`for (const [granularity, bucketStart] of [["hour", …], ["day", …]])`); `pruneTokenLedger` (`:180-188`) likewise prunes only hour/day. **A 30m/4h token total needs minute rows.**
- `apps/server/src/analytics.ts:206-224` — the analytics **tokens lens** already reads the ledger per node (summed across models), and `foldCluster` sums `generated/prompt/cached`; `tokenModels` (`:287-295`) returns per-model totals over the range. So `GET /api/v1/analytics/tokens?range=X&groupBy=node` is the read path — no new endpoint.
- Cost formula (billable): input = (prompt − cached) × inputPrice; cached × cachedPrice; output = generated × outputPrice; all per million tokens.

Decision: extend the ledger engine to also write `minute` rows (same upsert) and prune them with `minuteKeepDays`; the tokens card sums the spark nodes' token points over the selected range. No cached-subset double count: prompt and cached are priced separately as above.

## 4. Cost settings (energy €/kWh, token €/Mtok input·cached·output, currency)

Evidence:

- `apps/server/src/cadence.ts:5-35` — the settings-row pattern: `settings(key, value jsonb)`, `get()` returns null when unset/out of bounds, `set()` upserts on `settings.key`; routes `GET/PUT /api/v1/settings/cadence-ms` at `apps/server/src/app.ts:235-251` with a zod schema (`packages/core/src/cadence.ts:11-13`).
- `packages/db/src/schema.ts:77-80` — `settings` table is generic (key text PK, value jsonb) — no migration needed.

Decision: new `apps/server/src/cost.ts` service (keys `energy_cost`, `token_cost`) with zod validation in `packages/core/src/cost.ts`: energy `{ pricePerKwh: 0 < x ≤ 100, currency: "EUR"|"USD"|"GBP" }`, token `{ input, cached, output: 0 ≤ x ≤ 1000, currency }` (€/Mtok). Routes `GET/PUT /api/v1/settings/energy-cost` and `/token-cost` (503 when degraded, like cadence). One currency setting shared by both — the modal shows it in each section for proximity, PUTs write the same key.

## 5. Queue running/waiting availability

Evidence:

- `packages/core/src/llm.ts:34-35` — `queueRunning`/`queueWaiting` are independently nullable per probe.
- `apps/server/src/llm-history.ts:13-14` and `packages/db/src/schema.ts:148-150` — both counters bucket separately (queue_running, queue_waiting).
- `apps/web/src/llm-data.ts:41-47` — `formatQueue` already omits null sides.

Decision: the hero Queue stat shows `running` only when `queueWaiting === null` (sub `running`), both when present (sub `running · waiting`); the stat itself only hides when both are null.

## 6. Hero no-data behavior + two-engine layout

Evidence:

- `apps/web/src/overview.ts:12-26` — `HeroData` fields are nullable; `ttftP95Ms`/`itlP95Ms` are histogram quantiles → null when the engine published no histogram.
- `apps/web/src/components/OverviewView.vue:247-252` — today the statgrid is always 6 columns and renders `—` for missing TTFT/ITL; the body duplicates the model name under the card head.
- `apps/web/src/overview.ts:96-104` — `heroSpark()` labels are hardcoded "30m" (must follow the selected range).

Decision: hide TTFT when `ttftP95Ms === null && e2eP95Ms === null`, ITL when `itlP95Ms === null`; grid becomes 4 columns and a muted line "ttft · itl appear with the first requests" replaces the hidden pair. Heads: h3 truncates (`text-overflow: ellipsis`), node label never wraps, a `dot--run` serving/starting chip replaces the body's name row. Range filter re-fetches charts + cards on change.

## 7. NAS download summary

Evidence:

- `GET /api/v1/downloads` (`apps/server/src/app.ts:708-712`) returns queue entries incl. `status`, `bytesDone`, `bytesTotal`, `speedBps` (`packages/core/src/downloads.ts:74-76`).
- `apps/web/src/models.ts:199-233` — ready-made pure helpers: `downloadProgressPct`, `downloadBytesLine`, `downloadSpeedView`, `downloadEntryEta`; `formatEta` renders seconds.

Decision: Overview polls `fetchDownloadQueue()` every 10 s; the first `status === "running"` entry renders a compact progress row in the NAS card (name · eta · bar · `% · bytes · speed`), hidden when the queue is idle. All downloads run on the NAS store node (IRI-015 dispatch), so any running entry belongs there.

## 8. Topbar settings CTA + connection chip

Evidence:

- `apps/web/src/App.vue:99-101` — footer `iconbtn` gear opens `hubSettingsOpen`; the topbar right side has only the theme toggle (`:94-97`).
- `apps/web/src/live.ts:63-64,97,216-223` — `connected` ref is true only while the EventSource is OPEN; `onerror` sets false. Today the topbar shows "Live · Xs" / "Connecting…" chips.

Decision: move the gear next to the theme toggle (right of it), remove it from the footer (footer keeps version · tag · interval · watts). Replace the status chips: **no chip while connected**, a warn `dot--warn OFFLINE` chip when `!connected`.

## Summary of Findings

1. Ranges: add `4h` to history (minute buckets) and `30m`+`4h` to analytics (minute); week/month are labels over existing 7d/30d. Retention already covers everything.
2. Power bar chart + fleet-now come from the existing analytics power lens (per-node `watts`), summed client-side over sparks; envelope = `GB10_SYSTEM_ENVELOPE_W`.
3. Token totals come from the existing analytics tokens lens; the only backend gap is minute-granularity ledger rows (write + prune).
4. Cost settings follow the cadence settings-row pattern; no migration (generic settings table).
5. Queue: per-side nullability is already in the wire shape; render conditionally.
6. Download summary: existing queue API + pure helpers cover name/pct/bytes/speed/eta.
7. Topbar: gear moves next to the theme toggle; `connected` already models the OFFLINE state.

Open: none blocking. Currency list fixed to EUR/USD/GBP (symbols €/$/£) — extend the enum if the owner asks.
