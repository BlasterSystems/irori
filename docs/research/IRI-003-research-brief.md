# IRI-003 research brief — M2 telemetry collectors & rollups

- **Date:** 2026-10-17
- **Ticket:** IRI-003 (M2) — Jira [IR-14](https://blastersystems.atlassian.net/browse/IR-14)
- **Goal:** What exactly do the collectors read on the fleet (GB10 Spark quirks included), and how do rollups stay bounded/idempotent?

## 1. GPU collector — proven query set (sparkControl, in production on this fleet)

`sparkControl/server/collectors/SystemCollector.js:219` uses:

```
nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit, \
  clocks.current.sm,clocks.max.sm, \
  clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown, \
  clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_power_cap, \
  index,name,uuid --format=csv,noheader,nounits
```

plus `--query-gpu=memory.used,memory.total` and
`--query-compute-apps=pid,process_name,used_memory`. Field order = the query
order; parse semantics proven in `__tests__/systemCollectorParse.test.js`:

- `[N/A]`, empty → null (`_parseSmiNumber`); floats kept.
- Throttle reason hex fields map to `ok|thermal|power|hw|unknown`
  (thermal = hw_thermal || sw_thermal; active = thermal || hw_slowdown || power_cap).
- `power.draw` is a float; `power.limit` may be N/A (default 120 is sparkControl's
  display fallback — Irori keeps null instead, per "Not detected = unknown").

**Irori decision:** same query set; keep nulls instead of fallback values.

## 2. GB10 unified memory (the big quirk)

`SystemCollector.multiGpu.test.js:88` — "a lone GB10 (memory N/A) inherits the
aggregate VRAM": on DGX Spark, per-GPU `memory.used/total` come back `[N/A]`
because the memory is unified. The OS-visible pool is `/proc/meminfo`
(`SystemCollector.js:343,643`: "Unified-memory pool size + actual available
memory"). **Irori decision:** `gpus[].memUsedBytes/memTotalBytes` = null when
N/A; `memory.totalBytes/usedBytes` from `/proc/meminfo`; add optional
`unifiedMemory: { poolBytes, availableBytes }` when MemTotal matches a
GB10-class host — labeled "not detected" where unreadable (AGENTS.md rule).
The exact GPU-slice split needs verification on a real Spark (dgx1 SSH was
unreachable from here — port filtered; retry from the LAN).

## 3. CPU temp / package power / clocks

- **CPU temp:** hwmon sysfs (`SystemCollector.js:713-715`: `/sys/class/hwmon/hwmon*/temp*_input`
  + name) — proven approach; pick the package/cpu-labeled sensor, else max.
- **Package power:** sparkControl has NO rapl source (grep: 0 hits) — unproven
  on GB10. **Irori decision:** try `/sys/class/powercap/intel-rapl:*/energy_uj`
  (x86), then hwmon `power*_average`/`power*_input`, else null. Tolerant;
  energy estimation is M7 and will need real measurements.
- **CPU usage:** `/proc/stat` first-line deltas over ~200 ms (same as M1).
- **Per-core clocks:** `scaling_cur_freq` under
  `/sys/devices/system/cpu/cpu*/cpufreq` — cheap, on-node; optional field.

## 4. Storage / network

- Storage: `statfs` per mount from `/proc/mounts` (real filesystems only:
  exclude tmpfs/overlay/loop/squashfs/efivarfs), totalBytes/usedBytes.
- Network: `/proc/net/dev` rx/tx byte deltas per interface (exclude `lo`),
  rates over the sample window. `SystemCollector.hostNet.test.js` covers the
  container-agent `/host/proc` mount variant — Irori agents run bare-metal
  (root), so `/proc` is direct; keep a `HOST_PROC` override for container
  agents anyway (docker role exists).

## 5. Rollups / retention (ADR-0002 §Implementation, ADR-0006, SPEC §4)

- Buckets keyed by **server receive time** (ADR-0006: agent timestamps are
  advisory; clock jumps land in the correct server-side bucket).
- Raw snapshots retained 24 h (config), minute buckets 7 d, hourly 90 d,
  daily 1 y (SPEC §4 temp semantics generalized). Buckets carry min/avg/max
  for temps, avg for the rest, `samples` count.
- Watermark in `settings` (per bucket size, last completed bucket); rollups
  recompute from the watermark → idempotent under crash-restart; fake-timer
  tests for watermark + clock-jump.
- Ingest stays non-blocking: ring → SSE → fire-and-forget insert with the
  M1 bounded buffer.

## 6. SSH fallback parity

`packages/core` shapes are transport-independent (ADR-0003): the SSH fallback
(M2) runs the same collector code over an SSH exec channel, so snapshot shapes
are identical by construction. M2 wires the transport seam only; SSH exec
details follow M1's `transport` field (`"ssh"`).

## Summary of findings

- Query set + parse semantics: solved (sparkControl production code).
- GB10: per-GPU VRAM is N/A — use /proc/meminfo for the pool; nullable GPU mem.
- Package power on GB10: unproven — tolerant nulls + real-Spark verification
  deferred (dgx1 SSH unreachable from here: port filtered; retry from LAN).
- Rollups: watermark + server-receive-time buckets + configurable retention.
