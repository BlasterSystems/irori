import type { Express, NextFunction, Request, Response } from "express";
import type { AuditActor } from "@irori/core";
import type { AuditService } from "./audit.js";

/**
 * Per-route audit marker (IRI-077, epic IR-157 WS4).
 *
 * Mutating routes carry `audit({ action, targetType, … })` as route-level
 * middleware, so auditing is part of the route's own declaration. The marker
 * is tagged with a symbol, which lets `auditInventory(app)` walk the real
 * Express router and report every mutating route with or without a marker —
 * that is what the coverage test asserts against, so a new mutating route
 * registered without auditing fails the build rather than silently escaping
 * the record.
 *
 * One row per request is written when the response finishes — after the
 * handler — so the outcome (status/error) and the post-mutation state are both
 * real. An audit failure never fails the operator's action: the service
 * swallows and logs write errors.
 */

export interface AuditRouteOptions {
  /** `domain.verb`, e.g. `node.delete`, `settings.hf-token.put`. */
  action: string;
  /** Entity domain: `node`, `setup`, `settings`, `usage-client`… */
  targetType: string;
  /** Override the target id (default: `:id`/`:type`/`:kind` param, else body nodeId). */
  targetId?: (req: Request) => string | null;
  /** Entity state read before and after the handler; redacted on write. */
  snapshot?: (req: Request) => Promise<unknown>;
  /** One-line summary; default is derived from action + target. */
  summary?: (req: Request) => string;
  /** Force the actor for hub-internal triggers (retention, health engine). */
  actor?: AuditActor;
  /** Skip the row for outcomes that changed nothing (validation-only probes). */
  skip?: (req: Request, res: Response) => boolean;
  /**
   * Declares a POST-shaped route that mutates nothing (e.g. create-time
   * script validation — `test -x` on the agent). The coverage test accepts an
   * explicit exemption instead of an audit row, so "POST" never means
   * "audited" by accident and "no row here" is always a stated decision.
   */
  readOnly?: true;
}

const AUDIT_MARKER = Symbol.for("irori.audit-route");

type TaggedMiddleware = ((req: Request, res: Response, next: NextFunction) => void) & {
  [AUDIT_MARKER]?: AuditRouteOptions;
};

function tagged(fn: (req: Request, res: Response, next: NextFunction) => void, options: AuditRouteOptions): TaggedMiddleware {
  const middleware = fn as TaggedMiddleware;
  middleware[AUDIT_MARKER] = options;
  return middleware;
}

/** Identity headers are client-asserted (ADR-0010 §8): they name the actor, never authorize it. */
export function auditActorOf(req: Request, forced?: AuditActor): { actor: AuditActor; detail: string | null } {
  const client = requestHeader(req, "x-irori-client");
  if (forced) return { actor: forced, detail: client };
  if (client !== null) return { actor: "client", detail: client };
  // The hub holds no operator credential (LAN trust, ADR-0010 §8): a caller
  // with no identity header is recorded honestly as anonymous.
  return { actor: "anonymous", detail: null };
}

export function requestHeader(req: Request, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null;
}

function defaultTargetId(req: Request): string | null {
  const fromParams = req.params.id ?? req.params.type ?? req.params.kind;
  if (typeof fromParams === "string" && fromParams.length > 0) return fromParams;
  const body: unknown = req.body;
  if (body && typeof body === "object" && "nodeId" in body && typeof body.nodeId === "string" && body.nodeId.length > 0) {
    return body.nodeId;
  }
  return null;
}

const ACTION_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/**
 * Declares a mutating-verb route that changes nothing (a probe/validator).
 * Registers no audit row; the coverage test accepts the explicit declaration
 * in place of an action, so un-audited mutating routes stay a loud failure.
 */
export function auditReadOnly(reason: string): TaggedMiddleware {
  return tagged((_req, _res, next) => next(), { action: "read-only", targetType: reason, readOnly: true });
}

/**
 * Route-level audit middleware. `service()` is re-read per request so the hub
 * can come online (or degrade) without re-registering routes; while the audit
 * service is absent the route behaves exactly as unmanaged.
 */
export function audit(options: AuditRouteOptions, service: () => AuditService | null): TaggedMiddleware {
  if (!ACTION_RE.test(options.action)) {
    throw new Error(`audit action "${options.action}" must be domain.verb`);
  }
  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const auditService = service();
      if (auditService === null) return next();
      const targetId = options.targetId?.(req) ?? defaultTargetId(req);
      const { actor, detail } = auditActorOf(req, options.actor);
      const input = {
        actor,
        actorDetail: detail,
        action: options.action,
        targetType: options.targetType,
        targetId,
        summary: options.summary?.(req) ?? `${options.action} ${options.targetType}${targetId ? ` ${targetId}` : ""}`,
        requestId: requestHeader(req, "x-irori-request-id"),
        sourceAddr: req.ip ?? req.socket.remoteAddress ?? null,
        before: null as unknown,
      };
      const read = async (): Promise<unknown> => {
        if (!options.snapshot) return null;
        try {
          return await options.snapshot(req);
        } catch {
          return null;
        }
      };
      input.before = await read();
      // IR-193: the durable record must carry the guard's message, not just
      // the status — a 409 "port 8081 is already served by setup X" is the
      // actionable part. Capture the handler's JSON error body; non-JSON
      // failures fall back to the status line.
      let errorBody: string | null = null;
      const json = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode >= 400 && errorBody === null) {
          const message =
            typeof body === "object" && body !== null && "error" in body && typeof (body as { error: unknown }).error === "string"
              ? (body as { error: string }).error
              : null;
          if (message !== null) errorBody = message;
        }
        return json(body);
      }) as typeof res.json;
      res.once("finish", () => {
        if (options.skip?.(req, res)) return;
        const failed = res.statusCode >= 400;
        // The handler may enrich the row once ids only exist after the
        // mutation (created entity id, dispatched job id). res.locals is the
        // Express per-request bag, so reads stay narrowed rather than cast.
        const enrichedId = typeof res.locals.auditTargetId === "string" ? res.locals.auditTargetId : null;
        const enrichedSummary = typeof res.locals.auditSummary === "string" ? res.locals.auditSummary : null;
        const enrichedAfter: unknown = "auditAfter" in res.locals ? res.locals.auditAfter : undefined;
        void (async () => {
          const after = failed ? null : (enrichedAfter ?? (await read()));
          auditService.record(
            { ...input, targetId: enrichedId ?? targetId, summary: enrichedSummary ?? input.summary },
            {
              // A rejected attempt belongs in the record too: who tried what,
              // and the fact that it changed nothing. The guard's message is
              // the actionable part (IR-193).
              outcome: failed ? "error" : "ok",
              error: failed ? (errorBody ?? `HTTP ${res.statusCode}`) : null,
              after,
            },
          );
        })();
      });
      next();
    })();
  };
  middleware[AUDIT_MARKER] = options;
  return middleware;
}

export interface AuditRouteInfo {
  method: string;
  path: string;
  action: string | null;
  targetType: string | null;
  /** True for routes explicitly declared as mutating-verb-but-read-only. */
  readOnly: boolean;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface RouteLike {
  path: string;
  methods: Record<string, boolean>;
  stack: Array<{ handle: unknown }>;
}
interface LayerLike {
  route?: RouteLike;
}

/**
 * Reads the truth from the router: every mutating route registered on `app`
 * with the audit marker it carries (null when it has none). The coverage test
 * fails when any entry has a null action.
 *
 * Express 5 does not export its router/layer types, so the shape is asserted
 * once here as a named local and only traversed defensively (`?? []`).
 */
export function auditInventory(app: Express): AuditRouteInfo[] {
  // Express 5 keeps the router on `app.router`; older builds used `_router`.
  // Neither is in the public types, so the shape is asserted once here as a
  // named local and only traversed defensively (`?? []`).
  const holder = app as unknown as { router?: { stack?: LayerLike[] }; _router?: { stack?: LayerLike[] } };
  const router = holder.router ?? holder._router;
  const out: AuditRouteInfo[] = [];
  for (const layer of router?.stack ?? []) {
    const route = layer.route;
    if (!route) continue;
    for (const [method, on] of Object.entries(route.methods)) {
      if (!on) continue;
      const upper = method.toUpperCase();
      if (!MUTATING.has(upper)) continue;
      // The marker is one of the route's stack handles.
      let found: AuditRouteOptions | null = null;
      for (const entry of route.stack ?? []) {
        const tagged = entry.handle as TaggedMiddleware;
        const options = tagged?.[AUDIT_MARKER];
        if (options) {
          found = options;
          break;
        }
      }
      out.push({
        method: upper,
        path: route.path,
        action: found?.action ?? null,
        targetType: found?.targetType ?? null,
        readOnly: found?.readOnly === true,
      });
    }
  }
  return out;
}
