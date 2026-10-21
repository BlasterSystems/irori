import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { CaptureProxy } from "../src/index.js";
import type { UsageRequest } from "@irori/core";

/**
 * IR-54 wire fixtures: parallel tool_call deltas reassemble by index; the
 * next request's role:"tool" results lift per-call chars and error flags.
 * Attribution is retention-independent — the proxy below runs with
 * retention off.
 */

let engine: Server;
let enginePort: number;

beforeAll(async () => {
  engine = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as { fixture?: "calls" };
      res.writeHead(200, { "content-type": "application/json" });
      if (body.fixture === "calls") {
        // Parallel tool calls: fragments arrive interleaved across indices.
        const chunks = [
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"get_wea","arguments":"{\\"city\\":"}}]}}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"get_time","arguments":"{\\"tz\\":"}}]}}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \\"SF\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"name":"","arguments":"\\"UTC\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":120,"completion_tokens":9,"total_tokens":129}}\n\n',
          "data: [DONE]\n\n",
        ];
        for (const chunk of chunks) res.write(chunk);
        res.end();
      } else {
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 210, completion_tokens: 5, total_tokens: 215 },
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

async function withProxy(run: (post: (body: string) => Promise<unknown>, next: () => Promise<UsageRequest>) => Promise<void>): Promise<void> {
  const waiters: Array<(e: UsageRequest) => void> = [];
  const proxy = new CaptureProxy({
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: enginePort,
    setupId: null,
    retention: null,
    onEvent: (e) => waiters.shift()?.(e),
    log: () => {},
  });
  await proxy.start();
  const post = (body: string): Promise<unknown> => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxy.address!.port,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end(body);
    return promise;
  };
  const next = (): Promise<UsageRequest> => new Promise<UsageRequest>((resolve) => waiters.push(resolve));
  try {
    await run(post, next);
  } finally {
    await proxy.stop();
  }
}

describe("tool attribution capture (IR-54)", () => {
  it("reassembles parallel tool_call fragments by index", async () => {
    await withProxy(async (post, next) => {
      const done = next();
      await post(JSON.stringify({ model: "m", stream: true, fixture: "calls", messages: [{ role: "user", content: "weather + time?" }] }));
      const e = await done;
      expect(e.finishReason).toBe("tool_calls");
      expect(e.respTools).toEqual([
        { id: "call_a", name: "get_wea", argsChars: `{"city": "SF"}`.length },
        // The name fragment was empty; the assembled name stays "get_time".
        { id: "call_b", name: "get_time", argsChars: `{"tz":"UTC"}`.length },
      ]);
      expect(e.toolResults).toEqual([]);
    });
  });

  it("lifts role:tool results (chars + error flags) from the follow-up request", async () => {
    await withProxy(async (post, next) => {
      const first = next();
      await post(JSON.stringify({ model: "m", stream: true, fixture: "calls", messages: [] }));
      await first;
      const second = next();
      await post(
        JSON.stringify({
          model: "m",
          stream: false,
          messages: [
            { role: "tool", tool_call_id: "call_a", content: "{\"forecast\":\"sunny\",\"temp_c\":21}" },
            { role: "tool", tool_call_id: "call_b", content: { error: "clock unavailable" } },
            { role: "tool", tool_call_id: "call_c", content: "Error: upstream refused" },
          ],
        }),
      );
      const e = await second;
      expect(e.toolResults).toEqual([
        { callId: "call_a", resultChars: Buffer.byteLength("{\"forecast\":\"sunny\",\"temp_c\":21}"), error: false },
        { callId: "call_b", resultChars: Buffer.byteLength(JSON.stringify({ error: "clock unavailable" })), error: true },
        { callId: "call_c", resultChars: Buffer.byteLength("Error: upstream refused"), error: true },
      ]);
      expect(e.respTools).toEqual([]); // plain text response — no calls
    });
  });
});
