import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { CaptureProxy } from "../src/index.js";
import type { UsageRequest } from "@irori/core";

/**
 * Mock-engine fixtures: an OpenAI-compatible upstream behind the capture
 * proxy. Each case pins one ADR-0008 invariant (byte-identity, fail-open,
 * selective capture, token/TensorFold extraction, error signatures).
 *
 * The engine paces SSE chunks with real timers: the streamed arrival pattern
 * is the behavior under test (TTFT/decode windows) — fake timers cannot drive
 * real sockets.
 */

let engine: Server;
let enginePort: number;
const seenAuth: string[] = [];

/** SSE engine: role → 3 content deltas → final usage+tensorfold chunk → DONE. */
function startStreamEngine(): void {
  engine = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
    if (req.method === "POST" && req.url?.split("?")[0] === "/v1/chat/completions") {
      if (req.url.includes("fail=1")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "Model 'nope' not found (req 7f3a2b10-1234-4abc-9def-0123456789ab, attempt 2)" },
          }),
        );
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        let parsed: { stream?: boolean };
        try {
          parsed = JSON.parse(body) as { stream?: boolean };
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (parsed.stream) {
          const chunks = [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{"content":"lo "}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{"content":"world"}}]}\n\n',
            'data: {"id":"cmpl-1","model":"GLM-5.3-Flash-EXL3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],' +
              '"tensorfold":{"prefill_s":0.7778,"decode_s":0.4541,"rounds":2,"drafts":true,"drafted":2,"accepted":1},' +
              '"usage":{"prompt_tokens":1221,"completion_tokens":4,"total_tokens":1225,' +
              '"prompt_tokens_details":{"cached_tokens":7},"completion_tokens_details":{"reasoning_tokens":4}}}\n\n',
            "data: [DONE]\n\n",
          ];
          let i = 0;
          const tick = (): void => {
            if (i >= chunks.length) return void res.end();
            res.write(chunks[i] ?? "");
            i += 1;
            setTimeout(tick, i === 1 ? 25 : 15);
          };
          tick();
        } else {
          res.end(
            JSON.stringify({
              id: "cmpl-2",
              model: "GLM-5.3-Flash-EXL3",
              choices: [{ index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            }),
          );
        }
      });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":[{"id":"GLM-5.3-Flash-EXL3"}]}');
      return;
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Model 'nope' not found (req 7f3a2b10-1234-4abc-9def-0123456789ab, attempt 2)" },
      }),
    );
  });
  engine.listen(0, "127.0.0.1");
}

const events: UsageRequest[] = [];
let nextEvent: () => Promise<UsageRequest>;
let proxy: CaptureProxy;

beforeAll(async () => {
  startStreamEngine();
  await new Promise<void>((resolve) => engine.once("listening", resolve));
  enginePort = engine.address()!.port;

  const waiters: Array<(e: UsageRequest) => void> = [];
  proxy = new CaptureProxy({
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: enginePort,
    setupId: "11111111-1111-4111-8111-111111111111",
    onEvent: (e) => {
      events.push(e);
      waiters.shift()?.(e);
    },
    log: () => {},
  });
  await proxy.start();
  nextEvent = () =>
    new Promise<UsageRequest>((resolve) => {
      waiters.push(resolve);
    });
});

afterEach(() => {
  events.length = 0;
});

afterAll(async () => {
  await proxy.stop();
  await new Promise<void>((resolve) => engine.close(() => resolve()));
});

function post(body: string, path = "/v1/chat/completions"): Promise<{ status: number; raw: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; raw: string }>();
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port: proxy.address!.port,
      method: "POST",
      path,
      headers: { "content-type": "application/json", authorization: "Bearer test-key", "content-length": Buffer.byteLength(body) },
    },
    (res) => {
      let raw = "";
      res.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, raw }));
    },
  );
  req.on("error", reject);
  req.end(body);
  return promise;
}

function postStreaming(body: string): Promise<{ status: Promise<number>; res: Promise<IncomingMessage> }> {
  const headersDone = Promise.withResolvers<IncomingMessage>();
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port: proxy.address!.port,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    },
    (res) => headersDone.resolve(res),
  );
  req.on("error", () => {});
  req.end(body);
  return { status: headersDone.promise.then((res) => res.statusCode ?? 0), res: headersDone.promise };
}

function get(path: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const req = httpRequest({ host: "127.0.0.1", port: proxy.address!.port, method: "GET", path }, (res) => {
    res.resume();
    res.on("end", resolve);
  });
  req.end();
  return promise;
}

describe("capture proxy", () => {
  it("streams byte-identically and captures the full OpenAI + TensorFold record", async () => {
    const body = JSON.stringify({ model: "GLM-5.3-Flash-EXL3", stream: true, messages: [{ role: "user", content: "hi" }] });
    const event = nextEvent();
    const res = await post(body);
    expect(res.status).toBe(200);
    const dataLines = res.raw
      .split("\n\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    expect(dataLines.at(-1)).toBe("[DONE]");
    expect(dataLines.filter((l) => l !== "[DONE]")).toHaveLength(5);
    expect(seenAuth).toContain("Bearer test-key");

    const e = await event;
    expect(e.model).toBe("GLM-5.3-Flash-EXL3");
    expect(e.stream).toBe(true);
    expect(e.endpoint).toBe("/v1/chat/completions");
    expect(e.status).toBe(200);
    expect(e.finishReason).toBe("stop");
    expect(e.ttftMs).toBeGreaterThanOrEqual(25);
    expect(e.decodeTps).toBeGreaterThan(0);
    expect(e.promptTokens).toBe(1221);
    expect(e.completionTokens).toBe(4);
    expect(e.cachedTokens).toBe(7);
    expect(e.reasoningTokens).toBe(4);
    expect(e.totalTokens).toBe(1225);
    expect(e.engineMeta).toEqual({ prefill_s: 0.7778, decode_s: 0.4541, rounds: 2, drafts: true, drafted: 2, accepted: 1 });
    expect(e.reqBytes).toBe(Buffer.byteLength(body));
    expect(e.resBytes).toBe(res.raw.length);
    expect(e.setupId).toBe("11111111-1111-4111-8111-111111111111");
    expect(e.sourceAddr).toContain("127.0.0.1");
  });

  it("captures non-streaming responses from the buffered JSON body", async () => {
    const body = JSON.stringify({ model: "GLM-5.3-Flash-EXL3", messages: [{ role: "user", content: "hi" }] });
    const event = nextEvent();
    const res = await post(body);
    expect(res.status).toBe(200);
    const e = await event;
    expect(e.stream).toBe(false);
    expect(e.ttftMs).toBeNull();
    expect(e.completionTokens).toBe(3);
    expect(e.totalTokens).toBe(13);
    expect(e.finishReason).toBe("stop");
    expect(e.resBytes).toBe(res.raw.length);
  });

  it("does not capture non-inference traffic (probes, metrics, models)", async () => {
    await get("/v1/models");
    expect(events).toHaveLength(0);
  });

  it("skips capture for POSTs without a parseable OpenAI body", async () => {
    await post("{not json");
    // Give the loop a beat via a second request's completion signal.
    await get("/v1/models");
    expect(events).toHaveLength(0);
  });

  it("records upstream-unreachable as a capture event with a 502", async () => {
    const dead = new CaptureProxy({ listenPort: 0, targetHost: "127.0.0.1", targetPort: 1, setupId: null, onEvent: (e) => events.push(e), log: () => {} });
    await dead.start();
    try {
      const { promise, resolve } = Promise.withResolvers<{ status: number; raw: string }>();
      const req = httpRequest({ host: "127.0.0.1", port: dead.address!.port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } }, (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => (raw += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, raw }));
      });
      req.end(JSON.stringify({ model: "m", messages: [] }));
      const res = await promise;
      expect(res.status).toBe(502);
      expect(events).toHaveLength(1);
      expect(events[0]!.status).toBeNull();
      expect(events[0]!.error).toContain("upstream unreachable");
      expect(events[0]!.errorSig).toContain("upstream unreachable");
    } finally {
      await dead.stop();
    }
  });

  it("normalizes error signatures for grouping", async () => {
    const event = nextEvent();
    const res = await post(JSON.stringify({ model: "nope", messages: [] }), "/v1/chat/completions?fail=1");
    expect(res.status).toBe(400);
    const e = await event;
    expect(e.status).toBe(400);
    expect(e.error).toContain("not found");
    expect(e.errorSig).toBe("Model 'nope' not found (req U, attempt N)");
  });

  it("keeps traffic flowing when the capture sink throws", async () => {
    const throwing = new CaptureProxy({
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: enginePort,
      setupId: null,
      onEvent: () => {
        throw new Error("sink exploded");
      },
      log: () => {},
    });
    await throwing.start();
    try {
      const { promise, resolve } = Promise.withResolvers<{ status: number; raw: string }>();
      const req = httpRequest({ host: "127.0.0.1", port: throwing.address!.port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } }, (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => (raw += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, raw }));
      });
      req.end(JSON.stringify({ model: "m", messages: [] }));
      const res = await promise;
      expect(res.status).toBe(200);
      expect(res.raw).toContain("Hello world");
    } finally {
      await throwing.stop();
    }
  });

  it("records client aborts and keeps serving", async () => {
    const body = JSON.stringify({ model: "GLM-5.3-Flash-EXL3", stream: true, messages: [{ role: "user", content: "hi" }] });
    const event = nextEvent();
    const { status, res } = postStreaming(body);
    expect(await status).toBe(200);
    // Headers arrived; abort the client mid-stream.
    (await res).destroy();
    const e = await event;
    expect(e.error).toContain("aborted");

    const after = await post(body);
    expect(after.status).toBe(200);
    expect(after.raw).toContain("[DONE]");
  });
});
