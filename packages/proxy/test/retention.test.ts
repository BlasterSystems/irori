import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { CaptureProxy } from "../src/index.js";
import type { BodyRetention, UsagePartWire, UsageRequest } from "@irori/core";

/**
 * IR-52 body retention: content-addressed parts, caps, truncation markers,
 * response assembly. Each case pins one invariant; the engine replays
 * fixture-driven deltas so streaming shapes stay data-driven.
 */

let engine: Server;
let enginePort: number;

interface FixtureBody {
  stream?: boolean;
  messages?: unknown[];
  fixtureDeltas?: Array<Record<string, unknown>>;
  fixtureContent?: string;
}

beforeAll(async () => {
  engine = createServer((req, res) => {
    if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    if (req.url.includes("fail=1")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Model 'nope' not found" } }));
      return;
    }
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as FixtureBody;
      res.writeHead(200, { "content-type": "application/json" });
      if (body.stream === true) {
        for (const delta of body.fixtureDeltas ?? []) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      } else {
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: body.fixtureContent ?? "Hello world" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          }),
        );
      }
    });
  });
  engine.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => engine.once("listening", resolve));
  enginePort = engine.address()!.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => engine.close(() => resolve()));
});

/** One proxy per test — retention is fixed at construction. */
async function withProxy(
  retention: BodyRetention | null,
  run: (post: (body: string, path?: string) => Promise<{ status: number; raw: string }>, next: () => Promise<UsageRequest>) => Promise<void>,
): Promise<void> {
  const events: UsageRequest[] = [];
  const waiters: Array<(e: UsageRequest) => void> = [];
  const proxy = new CaptureProxy({
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: enginePort,
    setupId: "22222222-2222-4222-8222-222222222222",
    retention,
    onEvent: (e) => {
      events.push(e);
      waiters.shift()?.(e);
    },
    log: () => {},
  });
  await proxy.start();
  const post = (body: string, path = "/v1/chat/completions"): Promise<{ status: number; raw: string }> => {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; raw: string }>();
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxy.address!.port,
        method: "POST",
        path,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let rawOut = "";
        res.on("data", (c: Buffer) => (rawOut += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, raw: rawOut }));
      },
    );
    req.on("error", reject);
    req.end(body);
    return promise;
  };
  const next = (): Promise<UsageRequest> =>
    new Promise<UsageRequest>((resolve) => {
      waiters.push(resolve);
    });
  try {
    await run(post, next);
  } finally {
    await proxy.stop();
  }
}

const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function canonical(part: { gz: string }): unknown {
  return JSON.parse(gunzipSync(Buffer.from(part.gz, "base64")).toString("utf8"));
}

function expectHash(part: UsagePartWire): void {
  expect(part.hash).toBe(createHash("sha256").update(gunzipSync(Buffer.from(part.gz, "base64"))).digest("hex"));
}

describe("body retention (IR-52)", () => {
  it("stores zero body bytes when retention is off", async () => {
    await withProxy(null, async (post, next) => {
      const done = next();
      const res = await post(JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] }));
      expect(res.status).toBe(200);
      const e = await done;
      expect(e.parts).toEqual([]);
    });
  });

  it("stores message + response parts and dedupes repeated history", async () => {
    const system = { role: "system", content: "You are terse." };
    const user = { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: IMAGE } }] };
    await withProxy({ bodyCapBytes: 1024 * 1024, partCapBytes: 1024 * 1024 }, async (post, next) => {
      const first = next();
      await post(JSON.stringify({ model: "m", stream: false, messages: [system, user] }));
      const e1 = await first;
      expect(e1.parts.map((p) => p.kind)).toEqual(["message", "message", "response"]);
      expect(e1.parts[2]?.role).toBe("assistant");
      expect(canonical(e1.parts[2]!)).toEqual({ role: "assistant", content: "Hello world" });
      for (const part of e1.parts) expectHash(part);

      const assistant = { role: "assistant", content: "Hello world" };
      const secondUser = { role: "user", content: "again" };
      const second = next();
      await post(JSON.stringify({ model: "m", stream: false, messages: [system, user, assistant, secondUser] }));
      const e2 = await second;
      // Sublinear growth: the repeated system + user messages hash identically.
      expect(e2.parts[0]?.hash).toBe(e1.parts[0]?.hash);
      expect(e2.parts[1]?.hash).toBe(e1.parts[1]?.hash);
      // The replayed assistant message equals the stored response part.
      expect(e2.parts[2]?.hash).toBe(e1.parts[2]?.hash);
      expect(e2.parts[3]?.kind).toBe("message");
      expect(e2.parts[4]?.kind).toBe("response");
    });
  });

  it("reassembles streamed content and tool_call deltas into the response part", async () => {
    const deltas: Array<Record<string, unknown>> = [
      { role: "assistant", content: "He" },
      { content: "llo" },
      {
        tool_calls: [
          { index: 0, id: "call_1", function: { name: "get_wea", arguments: "{\"city\":" } },
          { index: 1, id: "call_2", function: { name: "get_time", arguments: "{}" } },
        ],
      },
      { tool_calls: [{ index: 0, function: { arguments: " \"SF\"}" } }] },
      { content: " done" },
    ];
    await withProxy({ bodyCapBytes: 1024 * 1024, partCapBytes: 1024 * 1024 }, async (post, next) => {
      const done = next();
      await post(
        JSON.stringify({
          model: "m",
          stream: true,
          fixtureDeltas: deltas,
          messages: [{ role: "user", content: "weather?" }],
        }),
      );
      const e = await done;
      const responsePart = e.parts.find((p) => p.kind === "response");
      expect(responsePart).toBeDefined();
      expect(canonical(responsePart!)).toEqual({
        role: "assistant",
        content: "Hello done",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_wea", arguments: "{\"city\": \"SF\"}" } },
          { id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      });
    });
  });

  it("truncates oversize parts into a valid-JSON wrapper", async () => {
    const big = { role: "user", content: "x".repeat(64 * 1024) };
    await withProxy({ bodyCapBytes: 1024 * 1024, partCapBytes: 2048 }, async (post, next) => {
      const done = next();
      await post(JSON.stringify({ model: "m", stream: false, messages: [big] }));
      const e = await done;
      const part = e.parts[0]!;
      expect(part.truncated).toBe(true);
      expect(part.bytes).toBe(Buffer.byteLength(JSON.stringify(big)));
      const decoded = canonical(part) as { irori_truncated: boolean; original_bytes: number; prefix: string };
      expect(decoded.irori_truncated).toBe(true);
      expect(decoded.original_bytes).toBe(part.bytes);
      expect(Buffer.byteLength(decoded.prefix, "utf8")).toBeLessThanOrEqual(2048);
    });
  });

  it("folds messages past the body cap into in-position truncation markers", async () => {
    const big = (fill: string) => ({ role: "user", content: fill.repeat(4000) });
    await withProxy({ bodyCapBytes: 4096, partCapBytes: 64 * 1024 }, async (post, next) => {
      const done = next();
      // big1 stores; big2 omits (marker in position); small still fits.
      await post(JSON.stringify({ model: "m", stream: false, messages: [big("a"), big("b"), { role: "user", content: "small" }] }));
      const e = await done;
      expect(e.parts.map((p) => p.kind)).toEqual(["message", "marker", "message", "response"]);
      expect(canonical(e.parts[1]!)).toEqual({ irori_body_truncated: true, omitted_messages: 1, omitted_bytes: expect.any(Number) });

      const tail = next();
      // small + one big still fit under 4 KiB; the second big omits.
      await post(JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: "s" }, big("c"), big("d")] }));
      const e2 = await tail;
      expect(e2.parts.map((p) => p.kind)).toEqual(["message", "message", "marker", "response"]);
      expect(canonical(e2.parts[2]!)).toMatchObject({ irori_body_truncated: true, omitted_messages: 1 });
    });
  });

  it("stores the error body of failed requests as an error part", async () => {
    await withProxy({ bodyCapBytes: 1024 * 1024, partCapBytes: 1024 * 1024 }, async (post, next) => {
      const done = next();
      const res = await post(JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] }), "/v1/chat/completions?fail=1");
      expect(res.status).toBe(400);
      const e = await done;
      const errorPart = e.parts.find((p) => p.kind === "error");
      expect(errorPart).toBeDefined();
      expect(canonical(errorPart!)).toEqual({ error: { message: "Model 'nope' not found" } });
    });
  });

  it("never loses the native event to a malformed message role", async () => {
    await withProxy({ bodyCapBytes: 1024 * 1024, partCapBytes: 1024 * 1024 }, async (post, next) => {
      const done = next();
      // Empty and over-length roles must coerce to null, not drop the event.
      await post(
        JSON.stringify({
          model: "m",
          stream: false,
          messages: [
            { role: "", content: "empty role" },
            { role: "x".repeat(80), content: "over-length role" },
          ],
        }),
      );
      const e = await done;
      expect(e.promptTokens).toBe(10); // native capture survived
      expect(e.parts.map((p) => p.kind)).toEqual(["message", "message", "response"]);
      expect(e.parts[0]?.role).toBeNull();
      expect(e.parts[1]?.role).toBeNull();
    });
  });
});
