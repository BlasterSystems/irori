# Branch: feat/iri-172-overview-hottest-source (IR-287)

## Business context

The Overview page head said `hottest 75.8°C DGX-1`, and right below it a bordered THERMAL row named only DGX-3 at 70 °C. The two disagreed because the row counted GPUs only, while the token takes the hotter of GPU and CPU, so DGX-1's 75.8 °C was its CPU. The owner asked (2026-11-27) to remove the warning and have "hottest" say whether it's the CPU or the GPU. Research: `tasks/research-overview-thermal-alert-hottest-source.md`.

## What changed

- The THERMAL alert row is gone from the Overview at every tier.
- The page-head token names the node, then the sensor, then the value: `hottest DGX-1 CPU 75.8°C`. When the hottest node's GPU and CPU read the same, it shows both: `hottest DGX-1 GPU/CPU 75.8°C`.
- The token still turns the warn colour at 70 °C and above.
- The overview mockup matches.

## Business rules and constraints

- "Hottest" is still the highest GPU or CPU package reading across online spark nodes; the NAS is still excluded.
- A tie means exactly equal readings as reported by the agent.

## Edge cases handled

- A node with only a CPU or only a GPU reading names that sensor.
- No readable sensor anywhere: the token is hidden, as before.

## Integration impact

None outside the web bundle. No API, schema or agent change.

## Out of scope and follow-ups

- Node cards, the small-tier temps card and the Analytics temps strip are unchanged; they already show both sensors.

## Verification

- `pnpm test`: all workspaces green. Web 70 files / 584 tests (new cases for GPU-wins, CPU-wins, tie, single-sensor nodes, the sensor label, and a mount test showing no alert row even with a GPU at 72 °C).
- `pnpm build`: green.

## Changelog

- feat(web): remove the Overview thermal alert row; the hottest token names its sensor (IR-287).
