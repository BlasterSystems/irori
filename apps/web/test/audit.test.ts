import { describe, expect, it, vi } from "vitest";
import {
  auditDomainOf,
  auditHashFor,
  auditTargetHash,
  auditVerbOf,
  diffSides,
  parseAuditHash,
} from "../src/audit-data";
import { fetchAudit, fetchEventJournal } from "../src/api";
import { parseHash } from "../src/router";
import appSource from "../src/App.vue?raw";
import nodeDetailSource from "../src/components/NodeDetail.vue?raw";
import serveViewSource from "../src/components/ServeView.vue?raw";
import hubSettingsSource from "../src/components/HubSettingsModal.vue?raw";

describe("parseAuditHash", () => {
  it("defaults on a bare or junk hash", () => {
    expect(parseAuditHash("#/audit")).toEqual({ range: "7d", actor: "all", domain: "", q: "", targetId: "" });
    expect(parseAuditHash("junk")).toEqual(parseAuditHash("#/audit"));
  });

  it("reads every filter from the query string", () => {
    expect(parseAuditHash("#/audit?range=30d&actor=agent&domain=setup&q=rotate&target=abc")).toEqual({
      range: "30d",
      actor: "agent",
      domain: "setup",
      q: "rotate",
      targetId: "abc",
    });
  });

  it("falls back per-field on junk values, never throws", () => {
    expect(parseAuditHash("#/audit?range=nope&actor=bogus")).toEqual({
      range: "7d",
      actor: "all",
      domain: "",
      q: "",
      targetId: "",
    });
  });

  it("caps oversized values at the server's bounds", () => {
    const parsed = parseAuditHash(`#/audit?q=${"x".repeat(200)}&domain=${"d".repeat(100)}`);
    expect(parsed.q.length).toBe(128);
    expect(parsed.domain.length).toBe(64);
  });
});

describe("auditHashFor round-trip", () => {
  it("writes and reads back non-default filters", () => {
    const h = auditHashFor({ range: "1h", actor: "hub", domain: "node", q: "del", targetId: "n-1" });
    expect(parseAuditHash(h)).toEqual({ range: "1h", actor: "hub", domain: "node", q: "del", targetId: "n-1" });
  });

  it("omits defaults and the actor=all chip", () => {
    expect(auditHashFor({ actor: "all" })).toBe("#/audit");
    expect(auditHashFor({ range: "7d" })).toBe("#/audit?range=7d");
  });

  it("the target deep link parses to the same target", () => {
    expect(parseAuditHash(auditTargetHash("00000000-0000-4000-8000-000000000001")).targetId).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
  });
});

describe("parseHash audit route", () => {
  it("routes #/audit with and without filters", () => {
    expect(parseHash("#/audit")).toEqual({ view: "audit" });
    expect(parseHash("#/audit?target=x")).toEqual({ view: "audit" });
  });
});

describe("diffSides", () => {
  it("returns null when neither side carries a shape", () => {
    expect(diffSides(null, null)).toBeNull();
  });

  it("flags a real change", () => {
    const d = diffSides({ host: "a.local" }, { host: "b.local" })!;
    expect(d.hasDiff).toBe(true);
    expect(d.before.text).toContain("a.local");
    expect(d.after.text).toContain("b.local");
  });

  it("key order alone is not a change", () => {
    const d = diffSides({ a: 1, b: 2 }, { b: 2, a: 1 })!;
    expect(d.hasDiff).toBe(false);
  });

  it("one-sided payloads render and diff", () => {
    const d = diffSides(null, { enabled: true })!;
    expect(d.before.text).toBe("");
    expect(d.hasDiff).toBe(true);
  });
});

describe("action split", () => {
  it("splits domain.verb", () => {
    expect(auditDomainOf("node.delete")).toBe("node");
    expect(auditVerbOf("node.delete")).toBe("delete");
    expect(auditVerbOf("settings.hf-token.put")).toBe("hf-token.put");
  });

  it("a dotless action keeps its whole name as the verb", () => {
    expect(auditDomainOf("weird")).toBe("weird");
    expect(auditVerbOf("weird")).toBe("weird");
  });
});

// The per-entity links and the nav entry are template wiring with no render
// layer (repo convention: no component mounting), so pin them against source.
it("nav and every entity view link into the Audit page", () => {
  expect(appSource).toContain('#/audit');
  expect(appSource.match(/#\/audit/g)!.length).toBeGreaterThanOrEqual(2); // full + hamburger nav
  expect(nodeDetailSource).toContain("auditTargetHash(nodeId)");
  expect(serveViewSource).toContain("auditDomainHash('setup')");
  expect(hubSettingsSource).toContain("auditDomainHash('settings')");
});

const AUDIT_ROW = {
  id: "42",
  ts: "2026-11-03T10:00:00.000Z",
  actor: "hub",
  actorDetail: null,
  action: "node.delete",
  targetType: "node",
  targetId: "00000000-0000-4000-8000-000000000001",
  summary: "deleted node spark2",
  before: { name: "spark2" },
  after: null,
  outcome: "ok",
  error: null,
  requestId: null,
  sourceAddr: null,
};

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("fetchAudit", () => {
  it("parses a page and forwards every filter to the query string", async () => {
    const fetchMock = mockFetch(200, { entries: [AUDIT_ROW], nextCursor: "41", total: 7 });
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchAudit({ range: "30d", actor: "agent", domain: "node", targetId: "abc", q: "delete", cursor: "99" });
    expect(page.entries[0]).toMatchObject({ id: "42", action: "node.delete" });
    expect(page.nextCursor).toBe("41");
    const url = String(fetchMock.mock.calls[0]![0]);
    for (const part of ["range=30d", "actor=agent", "domain=node", "targetId=abc", "q=delete", "cursor=99"]) {
      expect(url).toContain(part);
    }
    vi.unstubAllGlobals();
  });

  it("rejects an entry whose id is not a decimal string (wire contract)", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { entries: [{ ...AUDIT_ROW, id: 42 }], nextCursor: null, total: 1 }));
    await expect(fetchAudit({ range: "7d" })).rejects.toThrow("unexpected shape");
    vi.unstubAllGlobals();
  });

  it("surfaces the server error message on failure", async () => {
    vi.stubGlobal("fetch", mockFetch(503, { error: "database unavailable" }));
    await expect(fetchAudit({ range: "7d" })).rejects.toThrow("database unavailable");
    vi.unstubAllGlobals();
  });
});

describe("fetchEventJournal", () => {
  const FRAME = { id: "7", ts: "2026-11-03T10:00:00.000Z", type: "heartbeat", nodeId: null, payload: { type: "heartbeat", serverTimeMs: 1 } };

  it("parses journaled frames and builds the query", async () => {
    const fetchMock = mockFetch(200, { events: [FRAME], nextCursor: 6 });
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchEventJournal({ range: "24h", type: "heartbeat", nodeId: "n-1", limit: 50, cursor: 100 });
    expect(page.events[0]).toMatchObject({ id: "7", type: "heartbeat" });
    expect(page.nextCursor).toBe(6);
    const url = String(fetchMock.mock.calls[0]![0]);
    for (const part of ["range=24h", "type=heartbeat", "nodeId=n-1", "limit=50", "cursor=100"]) {
      expect(url).toContain(part);
    }
    vi.unstubAllGlobals();
  });

  it("drops frames whose payload is not a valid SSE event", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { events: [{ ...FRAME, payload: { type: "bogus" } }], nextCursor: null }));
    await expect(fetchEventJournal({ range: "1h" })).rejects.toThrow("unexpected shape");
    vi.unstubAllGlobals();
  });
});
