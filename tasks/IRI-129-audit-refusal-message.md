# Task: IRI-129 — audit keeps the refusal reason (IR-193)

Jira **IR-193** (Task, Medium).

## Objective

Audit rows for refused mutations stored `error: "HTTP 409"` only. The
actionable part — the guard message in the response body — was lost, so a
refusal could not be attributed from the durable record after the fact (the
21:43:19 start refusal on DEV is the concrete case).

## Acceptance criteria

- [x] The audit middleware captures the JSON `error` body on 4xx/5xx and stores
      it in the row's `error`; non-JSON bodies fall back to `HTTP <status>`.
- [x] A refused mutation records the guard message (test).
- [x] `docs/API.md` notes the field.

## Scope

- `apps/server/src/audit-routes.ts`: wrap `res.json` for the capture.
- `apps/server/test/audit.test.ts`: the rejected-attempt test now expects the
  message.
- `docs/API.md`: audit section.

## Verification

- `pnpm --filter @irori/server test`.
- Live: a refused start's audit row carries the guard message.
