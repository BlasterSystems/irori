# Branch: fix/iri-175-store-link-note (IR-291 follow-up)

## Business context

After modelctl 0.25.1 was rolled out on 2026-11-28, every Spark's node page still showed a red banner: "84 active entries are not visible as symlinks on this mount; sync from the store will not work for them". On those nodes syncing does work, because modelctl 0.25.1 reads the store's update journal instead of the symlink. The owner sent a screenshot of the wrong banner the same day.

## What changed

- The node page decides the tone from what the node can do. If the modelctl that runs the sync is 0.25.1 or newer, the hidden links are a quiet note saying syncing works there. If it is older or unknown, they are a warning that says how to fix it (raise the hub's modelctl pin, or mount the store over NFS).
- The agent's store warning now states the requirement ("syncing them from the store needs modelctl 0.25.1 or newer on this node") instead of "will not work".
- The rule for "which user's modelctl runs the sync" lives in one place (`pickSyncModelctlVersion`) and is shared by the hub and the web.

## Business rules and constraints

- The sync runs as the node's cache user; with none set, as the agent user (root, or the only user the node reports). Otherwise the version is unknown and the warning stays.
- Any other store warning (for example an unreadable catalog) is shown unchanged and takes precedence.

## Edge cases handled

- Agents still on the previous bundle send the old warning text; the page recognises it and replaces it with its own wording.
- One hidden link is worded in the singular.

## Integration impact

Web and agent bundle. No API or schema change; the hub's behaviour is unchanged (the shared helper replaces identical inline logic).

## Out of scope and follow-ups

- The NAS node's Store card still shows the agent's warning text as it is.

## Verification

- `pnpm test`: all workspaces green, with new cases for the note (web), the shared rule (core) and the agent's wording.
- `pnpm typecheck`: exit 0.

## Changelog

- fix(web,agent): the node page's store-link banner is a warning only when the node's modelctl cannot sync through hidden links (IR-291 / IRI-175).
