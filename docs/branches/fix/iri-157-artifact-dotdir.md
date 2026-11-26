# fix/iri-157-artifact-dotdir (IRI-157)

## Business context

The Add-node modal tells the operator to download `install-agent.sh`, the systemd unit and the agent bundle from the hub. When the hub's files sat under a hidden directory, all three downloads failed with a 404, and so did every client-side deep link (for example a reload on `/nodes/<id>`). That breaks onboarding and the one-click agent update, which fetches the bundle from the same route. It also failed the server test suite in worktrees under `~/.herdr/`.

## What changed

- The hub now sends each agent artifact, and the SPA's `index.html` fallback, relative to its own directory. The hidden-path check therefore applies only to the file name, not to the install path above it.

## Business rules and constraints

- Artifact paths come only from the hub's configuration, never from the request.
- A dot-named artifact file is still refused; only parent directories may be hidden.

## Edge cases handled

- Install path with one or more dot-directories.
- Missing artifact: still the existing 503 `agent artifacts not available`.

## Integration impact

- None. Container hubs (no hidden directories in `/app/...`) behave the same.

## Out of scope and follow-ups

- Provision modelctl as soon as a new agent connects, instead of waiting up to an hour for the scheduled inventory read.

## Verification

- `pnpm build`; `pnpm test`. The new onboarding test fails on `main` and passes on this branch.

## Changelog

- fix(server): same fix for the SPA fallback; review wording and temp-dir cleanup (quality-review F1 to F3).
- fix(server): serve agent artifacts from hidden-directory install paths.
