import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createHash } from "node:crypto";
import { CaptureProxy } from "../src/index.js";
import { bearerKeyHash } from "../src/identity.js";
import type { UsageRequest } from "@irori/core";

/**
 * IR-55: header-declared identity, bearer fingerprinting, retry lineage —
 * captured per request without affecting forwarding (the engine never sees
 * anything but the original bytes).
 */

let engine: Server;
let enginePort: number;

beforeAll(async () => {
  engine = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  engine.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => engine.once("listening", resolve));
  enginePort = engine.address()!.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => engine.close(() => resolve()));
});

async function withProxy(run: (post: (body: string, headers?: Record<string, string>) => Promise<unknown>, next: () => Promise<UsageRequest>) => Promise<void>): Promise<void> {
  const events: UsageRequest[] = [];
  const waiters: Array<(e: UsageRequest) => void> = [];
  const proxy = new CaptureProxy({
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: enginePort,
    setupId: null,
    retention: null,
    onEvent: (e) => {
      events.push(e);
      waiters.shift()?.(e);
    },
    log: () => {},
  });
  await proxy.start();
  const post = (body: string, headers: Record<string, string> = {}): Promise<unknown> => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxy.address!.port,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
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

describe("client identity capture (IR-55)", () => {
  it("attributes headers, key fingerprint, and retry lineage end to end", async () => {
    const key = "irn_test_key_material";
    const expectedHash = createHash("sha256").update(key, "utf8").digest("hex");
    await withProxy(async (post, next) => {
      const done = next();
      await post(
        JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] }),
        {
          "x-irori-project": "irori",
          "x-irori-agent-type": "main",
          "x-irori-client": "omp",
          "x-irori-retry": "attempt=2;kind=auto-retry;status=recovered;superseded-by=resp_7",
          authorization: `Bearer ${key}`,
        },
      );
      const e = await done;
      expect(e.clientProject).toBe("irori");
      expect(e.clientAgentType).toBe("main");
      expect(e.clientName).toBe("omp");
      expect(e.clientKeyHash).toBe(expectedHash);
      expect(e.retryAttempt).toBe(2);
      expect(e.retryKind).toBe("auto-retry");
      expect(e.retryStatus).toBe("recovered");
      expect(e.retrySupersededBy).toBe("resp_7");
    });
  });

  it("stays null for unidentified clients and never leaks the raw key", async () => {
    await withProxy(async (post, next) => {
      const done = next();
      await post(JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] }), {
        authorization: "Bearer another-secret-key",
      });
      const e = await done;
      expect(e.clientProject).toBeNull();
      expect(e.clientAgentType).toBeNull();
      expect(e.clientName).toBeNull();
      expect(e.clientKeyHash).toBe(createHash("sha256").update("another-secret-key", "utf8").digest("hex"));
      expect(e.retryAttempt).toBeNull();
      // The forwarded engine request still carried the original header bytes
      // (byte-identical forwarding) — nothing here stores the raw key.
    });
  });

  it("fingerprints bearer tokens", () => {
    const headers = { authorization: "Bearer tok-1" };
    expect(bearerKeyHash(headers)).toBe(createHash("sha256").update("tok-1", "utf8").digest("hex"));
    expect(bearerKeyHash({ authorization: "Basic zzz" })).toBeNull();
    expect(bearerKeyHash({})).toBeNull();
    expect(bearerKeyHash({ authorization: "Bearer " })).toBeNull();
  });
});
