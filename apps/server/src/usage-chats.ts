import { sql } from "drizzle-orm";
import { gunzipSync } from "node:zlib";
import { chatDetailSchema, chatsResponseSchema, usageRangeMs, type ChatDetail, type ChatsResponse, type UsageFilters, type UsageRange } from "@irori/core";
import type { Db } from "@irori/db";

/**
 * IR-53 chats: session chaining + reconstruction from IR-52 body parts.
 *
 * Grouping (read-time, ADR-0010 §6): requests of one client (key hash, else
 * name/project, else source address) within a time-gap window chain while
 * each request's message-part hash sequence extends the previous one
 * (every turn resends full history). A broken chain with a large input drop
 * marks the boundary `compacted` instead of splitting; any other break
 * starts a new session. Reconstruction yields exactly what the model saw:
 * the last request's message parts + its final response (+ markers).
 */

const SESSION_GAP_MS = 30 * 60_000;
const MAX_SESSIONS = 200;
/** Detail lookup window around a session start when re-chaining. */
const DETAIL_WINDOW_MS = 48 * 3_600_000;

interface RequestRow {
  id: string;
  receivedMs: number;
  tsMs: number;
  model: string | null;
  endpoint: string;
  sourceAddr: string | null;
  clientKeyHash: string | null;
  clientName: string | null;
  clientProject: string | null;
  clientAgentType: string | null;
  promptTokens: number | null;
  totalTokens: number | null;
  /** True when any stored part was truncated at capture. */
  truncated: boolean;
  /** Ordered message-part hashes (kind = 'message'). */
  seq: string[];
}

interface Session {
  id: string;
  startMs: number;
  lastMs: number;
  lastTsMs: number;
  requests: number;
  messages: number;
  promptTokens: number | null;
  totalTokens: number;
  models: Set<string>;
  clientName: string | null;
  clientProject: string | null;
  clientAgentType: string | null;
  sourceAddrs: Set<string>;
  compacted: boolean;
  truncated: boolean;
  /** First message hash of the session — the compaction lineage signal. */
  firstHash: string | null;
  lastSeq: string[];
  lastPromptTokens: number | null;
  clientKey: string;
  lastRow: RequestRow;
}

function clientKey(row: RequestRow): string {
  return row.clientKeyHash ?? row.clientName ?? row.clientProject ?? row.sourceAddr ?? `addr:${row.sourceAddr ?? row.id}`;
}

function isPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length === 0 || prefix.length > full.length) return false;
  return prefix.every((hash, i) => hash === full[i]);
}

async function loadRequestRows(db: Db, range: UsageRange, nodeId: string | undefined, sinceIso: string): Promise<RequestRow[]> {
  const conds = [sql`r.received_at >= ${sinceIso}::timestamptz`];
  if (nodeId !== undefined) conds.push(sql`r.node_id = ${nodeId}`);
  const where = sql.join(conds, sql` and `);
  const rows = await db.execute(sql`
    select r.id, r.received_at, r.ts, r.model, r.endpoint, r.source_addr,
           r.client_key_hash, r.client_name, r.client_project, r.client_agent_type,
           r.prompt_tokens, r.total_tokens, bool_or(sp.truncated) as truncated,
           array_remove(array_agg(sp.hash order by sp.ordinal), null) as seq
    from llm_requests r
    join llm_request_parts sp on sp.request_id = r.id and sp.kind = 'message'
    where ${where}
    group by r.id
    order by r.received_at asc, r.ts asc, r.id asc
  `);
  const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    receivedMs: new Date(String(r.received_at)).getTime(),
    tsMs: new Date(String(r.ts)).getTime(),
    model: str(r.model),
    endpoint: str(r.endpoint) ?? "",
    sourceAddr: str(r.source_addr),
    clientKeyHash: str(r.client_key_hash),
    clientName: str(r.client_name),
    clientProject: str(r.client_project),
    clientAgentType: r.client_agent_type === "main" || r.client_agent_type === "subagent" ? r.client_agent_type : null,
    promptTokens: int(r.prompt_tokens),
    totalTokens: int(r.total_tokens),
    truncated: r.truncated === true,
    seq: Array.isArray(r.seq) ? (r.seq as string[]).filter((h): h is string => typeof h === "string") : [],
  }));
}

function chainSessions(rows: RequestRow[]): Session[] {
  const sessions: Session[] = [];
  let current: Session | null = null;
  const openNew = (row: RequestRow): Session => {
    const session: Session = {
      id: row.id,
      startMs: row.receivedMs,
      lastMs: row.receivedMs,
      lastTsMs: row.tsMs,
      requests: 1,
      messages: row.seq.length,
      promptTokens: row.promptTokens,
      totalTokens: row.totalTokens ?? 0,
      models: new Set(row.model === null ? [] : [row.model]),
      clientName: row.clientName,
      clientProject: row.clientProject,
      clientAgentType: row.clientAgentType,
      sourceAddrs: new Set(row.sourceAddr === null ? [] : [row.sourceAddr]),
      compacted: false,
      truncated: row.truncated,
      firstHash: row.seq[0] ?? null,
      lastSeq: row.seq,
      lastPromptTokens: row.promptTokens,
      lastRow: row,
      clientKey: clientKey(row),
    };
    sessions.push(session);
    return session;
  };
  for (const row of rows) {
    const key = clientKey(row);
    const timeGap = row.tsMs - (current?.lastTsMs ?? row.tsMs);
    if (
      current !== null &&
      current.clientKey === key &&
      timeGap <= SESSION_GAP_MS &&
      isPrefix(current.lastSeq, row.seq)
    ) {
      current.lastMs = row.receivedMs;
      current.lastTsMs = row.tsMs;
      current.requests += 1;
      current.messages = row.seq.length;
      current.promptTokens = row.promptTokens;
      current.totalTokens += row.totalTokens ?? 0;
      if (row.model !== null) current.models.add(row.model);
      if (row.sourceAddr !== null) current.sourceAddrs.add(row.sourceAddr);
      current.truncated = current.truncated || row.truncated;
      current.lastSeq = row.seq;
      current.lastPromptTokens = row.promptTokens;
      current.lastRow = row;
      continue;
    }
    if (
      current !== null &&
      current.clientKey === key &&
      timeGap <= SESSION_GAP_MS &&
      current.firstHash !== null &&
      row.seq[0] === current.firstHash && // compaction keeps the leading prompt (system)
      current.lastPromptTokens !== null &&
      row.promptTokens !== null &&
      row.promptTokens < current.lastPromptTokens * 0.5
    ) {
      // Broken prefix chain + large input drop + surviving first prompt =
      // compaction boundary (IR-53): same session, marked `compacted`. A
      // genuinely NEW conversation (different first message) splits even
      // when the input dropped.
      current.compacted = true;
      current.lastMs = row.receivedMs;
      current.lastTsMs = row.tsMs;
      current.requests += 1;
      current.messages = row.seq.length;
      current.promptTokens = row.promptTokens;
      current.totalTokens += row.totalTokens ?? 0;
      if (row.model !== null) current.models.add(row.model);
      if (row.sourceAddr !== null) current.sourceAddrs.add(row.sourceAddr);
      current.truncated = current.truncated || row.truncated;
      current.lastSeq = row.seq;
      current.lastPromptTokens = row.promptTokens;
      current.lastRow = row;
      continue;
    }
    current = openNew(row);
  }
  return sessions;
}

async function countCapturedWithoutBodies(db: Db, sinceIso: string, nodeId: string | undefined): Promise<number> {
  const conds = [sql`r.received_at >= ${sinceIso}::timestamptz`];
  if (nodeId !== undefined) conds.push(sql`r.node_id = ${nodeId}`);
  const where = sql.join(conds, sql` and `);
  const rows = await db.execute(sql`
    select count(*)::int as n
    from llm_requests r
    where ${where}
      and not exists (select 1 from llm_request_parts sp where sp.request_id = r.id and sp.kind = 'message')
  `);
  const row = (rows as unknown as Array<{ n: number }>)[0];
  return row !== undefined ? Number(row.n) : 0;
}

export interface UsageChats {
  list(filters: UsageFilters): Promise<ChatsResponse>;
  detail(sessionId: string): Promise<ChatDetail | null>;
}

export function createUsageChats(db: Db): UsageChats {
  return {
    async list({ range, nodeId }) {
      const sinceIso = new Date(Date.now() - usageRangeMs(range)).toISOString();
      const [rows, capturedWithoutBodies] = await Promise.all([
        loadRequestRows(db, range, nodeId, sinceIso),
        countCapturedWithoutBodies(db, sinceIso, nodeId),
      ]);
      const sessions = chainSessions(rows)
        .sort((a, b) => b.lastMs - a.lastMs)
        .slice(0, MAX_SESSIONS)
        .map((s) => ({
          id: s.id,
          startMs: s.startMs,
          lastMs: s.lastMs,
          requests: s.requests,
          messages: s.messages,
          promptTokens: s.promptTokens,
          totalTokens: s.totalTokens,
          models: [...s.models],
          clientName: s.clientName,
          clientProject: s.clientProject,
          clientAgentType: s.clientAgentType,
          sourceAddrs: [...s.sourceAddrs],
          compacted: s.compacted,
          truncated: s.truncated,
        }));
      return chatsResponseSchema.parse({ range, sessions, capturedWithoutBodies });
    },

    async detail(sessionId) {
      const [anchor] = await db.execute(sql`
        select r.received_at, r.client_key_hash, r.client_name, r.client_project, r.source_addr
        from llm_requests r where r.id = ${sessionId}
      `) as unknown as Array<{ received_at: string; client_key_hash: string | null; client_name: string | null; client_project: string | null; source_addr: string | null }>;
      if (anchor === undefined) return null;
      const anchorMs = new Date(anchor.received_at).getTime();
      // Re-chain the client's traffic from the anchor back (retention bounds
      // the forward side — no clip) and take its session's LAST request.
      const key = anchor.client_key_hash ?? anchor.client_name ?? anchor.client_project ?? anchor.source_addr;
      const sinceIso = new Date(Math.max(0, anchorMs - DETAIL_WINDOW_MS)).toISOString();
      const rows = await loadRequestRows(db, "90d", undefined, sinceIso);
      const scoped = rows.filter((row) => clientKey(row) === (key ?? `addr:${anchor.source_addr ?? sessionId}`));
      const session = chainSessions(scoped).find((s) =>
        scoped.some((row) => row.id === sessionId && row.receivedMs >= s.startMs && row.receivedMs <= s.lastMs),
      );
      // No session ⟹ the anchor has no stored message parts (chats need
      // bodies — the caller gets a 404, mirroring the list's empty state).
      const target = session?.lastRow;
      if (target === undefined) return null;

      const parts = await db.execute(sql`
        select sp.ordinal, sp.kind, sp.role, sp.bytes, sp.truncated, p.gz
        from llm_request_parts sp
        join llm_parts p on p.hash = sp.hash
        where sp.request_id = ${target.id}
        order by sp.ordinal
      `) as unknown as Array<{ ordinal: number; kind: string; role: string | null; bytes: number; truncated: boolean; gz: Buffer }>;
      const turns = parts.map((part) => {
        const base = { requestId: target.id, ts: target.tsMs, model: target.model };
        try {
          const decoded: unknown = JSON.parse(gunzipSync(Buffer.from(part.gz)).toString("utf8"));
          if (part.kind === "message" && decoded !== null && typeof decoded === "object") {
            const message = decoded as Record<string, unknown>;
            const content = message.content;
            let text: string | null = null;
            const imageUrls: string[] = [];
            let truncated = part.truncated;
            if (typeof content === "string") text = content;
            else if (Array.isArray(content)) {
              const texts: string[] = [];
              for (const block of content) {
                if (block === null || typeof block !== "object") continue;
                const b = block as Record<string, unknown>;
                if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
                if (b.type === "image_url" && b.image_url !== null && typeof b.image_url === "object") {
                  const url = (b.image_url as Record<string, unknown>).url;
                  if (typeof url === "string") imageUrls.push(url);
                }
              }
              text = texts.length > 0 ? texts.join("\n") : null;
            }
            if (truncated && decoded !== null && typeof decoded === "object" && "prefix" in (decoded as Record<string, unknown>)) {
              text = String((decoded as Record<string, unknown>).prefix ?? "");
            }
            const toolCalls = Array.isArray(message.tool_calls)
              ? (message.tool_calls as Array<Record<string, unknown>>).map((call) => {
                  const fn = call.function !== null && typeof call.function === "object" ? (call.function as Record<string, unknown>) : {};
                  return {
                    id: typeof call.id === "string" ? call.id : null,
                    name: typeof fn.name === "string" ? fn.name : "",
                    arguments: typeof fn.arguments === "string" ? fn.arguments : "",
                  };
                })
              : [];
            const roleValue = typeof message.role === "string" ? message.role : part.role;
            return chatDetailSchema.shape.turns.element.parse({
              ...base, kind: "message", role: roleValue, text, imageUrls, toolCalls,
              toolResult: roleValue === "tool" && typeof message.tool_call_id === "string"
                ? { callId: message.tool_call_id, error: false }
                : null,
              truncated,
            });
          }
          if (part.kind === "response" && decoded !== null && typeof decoded === "object") {
            const message = decoded as Record<string, unknown>;
            const toolCalls = Array.isArray(message.tool_calls)
              ? (message.tool_calls as Array<Record<string, unknown>>).map((call) => {
                  const fn = call.function !== null && typeof call.function === "object" ? (call.function as Record<string, unknown>) : {};
                  return { id: typeof call.id === "string" ? call.id : null, name: typeof fn.name === "string" ? fn.name : "", arguments: typeof fn.arguments === "string" ? fn.arguments : "" };
                })
              : [];
            return chatDetailSchema.shape.turns.element.parse({
              ...base, kind: "response", role: "assistant",
              text: typeof message.content === "string"
                ? message.content
                : typeof (message as Record<string, unknown>).prefix === "string"
                  ? ((message as Record<string, unknown>).prefix as string)
                  : null,
              imageUrls: [], toolCalls, toolResult: null, truncated: part.truncated,
            });
          }
          if (part.kind === "error") {
            const message = decoded as Record<string, unknown> | null;
            const err = message !== null && typeof message === "object" && message.error !== null && typeof message.error === "object"
              ? (message.error as Record<string, unknown>)
              : null;
            const text = err !== null && typeof err.message === "string"
              ? err.message
              : message !== null && typeof message === "object" && typeof message.raw === "string"
                ? message.raw
                : JSON.stringify(decoded);
            return chatDetailSchema.shape.turns.element.parse({
              ...base, kind: "error", role: null, text, imageUrls: [], toolCalls: [], toolResult: null, truncated: part.truncated,
            });
          }
          if (part.kind === "marker" && decoded !== null && typeof decoded === "object") {
            const omitted = (decoded as Record<string, unknown>).omitted_messages;
            return chatDetailSchema.shape.turns.element.parse({
              ...base, kind: "marker", role: null,
              text: typeof omitted === "number" ? `${omitted} earlier message(s) truncated by the capture cap` : "body truncated by the capture cap",
              imageUrls: [], toolCalls: [], toolResult: null, truncated: true,
            });
          }
          return chatDetailSchema.shape.turns.element.parse({
            ...base, kind: part.kind === "prompt" || part.kind === "input" ? "message" : "marker",
            role: part.role, text: JSON.stringify(decoded), imageUrls: [], toolCalls: [], toolResult: null, truncated: part.truncated,
          });
        } catch {
          // Missing/corrupt part bytes → visible gap, never a failed request.
          return chatDetailSchema.shape.turns.element.parse({
            requestId: target.id, kind: "marker", role: null,
            text: "(stored body part unavailable)", imageUrls: [], toolCalls: [], toolResult: null, truncated: true, ts: target.tsMs, model: target.model,
          });
        }
      });

      const sourceAddrs = new Set<string>();
      for (const row of scoped) if (row.receivedMs >= (session?.startMs ?? anchorMs) && row.receivedMs <= (session?.lastMs ?? anchorMs) && row.sourceAddr !== null) sourceAddrs.add(row.sourceAddr);
      if (target.sourceAddr !== null) sourceAddrs.add(target.sourceAddr);
      return chatDetailSchema.parse({
        id: session?.id ?? sessionId,
        startMs: session?.startMs ?? target.receivedMs,
        lastMs: session?.lastMs ?? target.receivedMs,
        requests: session?.requests ?? 1,
        compacted: session?.compacted ?? false,
        truncated: session?.truncated === true || turns.some((t) => t.truncated),
        clientName: target.clientName,
        clientProject: target.clientProject,
        clientAgentType: target.clientAgentType,
        sourceAddrs: [...sourceAddrs],
        models: [...(session?.models ?? new Set(target.model === null ? [] : [target.model]))],
        turns,
      });
    },
  };
}
