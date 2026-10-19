import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LiveRate, decodePrompt } from "../src/bench/decode.js";
import { BenchRunner } from "../src/bench/runner.js";
import { buildPrefillPrompt, rateFromSample, repeatsForSize, timeoutMsForSize, runPrefill } from "../src/bench/prefill.js";
import { generateSuite, scoreItem, visibleAnswer, lastInteger, numbersIn, type QualityItem } from "../src/bench/quality.js";
import { TOOLEVAL_SCENARIOS, checkArgs, runTooleval } from "../src/bench/tooleval.js";
import { runDecode } from "../src/bench/decode.js";

/**
 * Bench runners e2e against a local SSE fixture server: decode waves, the
 * prefill sweep and tooleval trials run over real HTTP; scoring and prompt
 * shaping are unit-tested directly.
 */

const sse = (res: import("node:http").ServerResponse, events: unknown[]): void => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

let server: Server;
let port: number;
/** Set by each test to shape the fixture responses. */
let handler: (body: Record<string, unknown>) => { events: unknown[]; status?: number };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* non-json */
      }
      const out = handler(body);
      if (out.status !== undefined) {
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
        return;
      }
      // A { __json: message } marker answers non-streaming JSON (tool-eval
      // trials); anything else streams as SSE.
      const marker = out.events[0] as Record<string, unknown> | undefined;
      if (marker && typeof marker === "object" && "__json" in marker) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: marker.__json }] }));
        return;
      }
      sse(res, out.events);
    });
  });
  port = await listen(server);
});

afterAll(() => {
  server.close();
});

/** One content delta chunk + a final usage chunk. */
function streamEvents(content: string, usage: Record<string, unknown>): unknown[] {
  const events: unknown[] = [];
  for (const ch of content) events.push({ choices: [{ delta: { content: ch } }] });
  events.push({ choices: [], usage });
  return events;
}

describe("quality scoring", () => {
  const item = (over: Partial<QualityItem>): QualityItem => ({
    id: "t",
    category: "qa",
    prompt: "p",
    answer: "391",
    mode: "number",
    maxTokens: 64,
    thinking: false,
    ...over,
  });

  it("scores number mode on the last number only", () => {
    expect(scoreItem(item({}), "The result is 391.")).toBe(true);
    expect(scoreItem(item({}), "391 or 5")).toBe(false);
    expect(scoreItem(item({}), "1391")).toBe(false);
  });

  it("folds thousands commas", () => {
    expect(scoreItem(item({ answer: "998001" }), "998,001")).toBe(true);
  });

  it("strips think blocks before scoring", () => {
    expect(scoreItem(item({}), "<think>hmm 402</think>391")).toBe(true);
    expect(scoreItem(item({}), "<think>hmm</think>The answer is 391.")).toBe(true);
  });

  it("scores word mode negation-aware", () => {
    expect(scoreItem(item({ answer: "canberra", mode: "word" }), "Canberra")).toBe(true);
    expect(scoreItem(item({ answer: "canberra", mode: "word" }), "Canberra, not Sydney")).toBe(true);
    expect(scoreItem(item({ answer: "canberra", mode: "word" }), "Not Canberra")).toBe(false);
    expect(scoreItem(item({ answer: "canberra", mode: "word" }), "Canberra is wrong")).toBe(false);
    // An essay is not a commitment.
    expect(scoreItem(item({ answer: "canberra", mode: "word" }), `${"Canberra ".repeat(50)}`)).toBe(false);
  });

  it("scores list mode on the last N integers in order", () => {
    expect(scoreItem(item({ answer: "1, 2, 4, 7, 9", mode: "list" }), "1, 2, 4, 7, 9")).toBe(true);
    expect(scoreItem(item({ answer: "1, 2, 4, 7, 9", mode: "list" }), "sorted: 1, 2, 4, 7, 9")).toBe(true);
    expect(scoreItem(item({ answer: "1, 2, 4, 7, 9", mode: "list" }), "1, 2, 4, 9, 7")).toBe(false);
  });

  it("scores gsm8k via the Answer line, falling back to the last integer", () => {
    const g = item({ mode: "gsm8k", answer: "540" });
    expect(scoreItem(g, "Reasoning...\nAnswer: 540")).toBe(true);
    expect(scoreItem(g, "Reasoning...\nAnswer: 541")).toBe(false);
    expect(scoreItem(g, "so it is 540")).toBe(true);
    expect(scoreItem(g, "no number here")).toBe(false);
  });

  it("scores mmlu via the last letter line", () => {
    const m = item({ mode: "mmlu", answer: "c" });
    expect(scoreItem(m, "Answer: C")).toBe(true);
    expect(scoreItem(m, "(C) is correct")).toBe(true);
    expect(scoreItem(m, "first B then Answer: C")).toBe(true);
    expect(scoreItem(m, "Answer: B")).toBe(false);
    expect(scoreItem(m, "I like the letter A in general")).toBe(false);
  });

  it("extracts numbers with sign/comma rules", () => {
    expect(numbersIn("dates 2024-01-01 and 1,234")).toEqual([2024, 1, 1, 1234]);
    expect(lastInteger("a1 b22")).toBe("22");
  });

  it("visibleAnswer cuts an unterminated think block", () => {
    expect(visibleAnswer("<think>partial")).toBe("");
  });
});

describe("quality suite", () => {
  it("is deterministic per category", () => {
    const a = generateSuite(["qa", "reason", "arith", "track", "gsm8k", "mmlu"]);
    const b = generateSuite(["qa", "reason", "arith", "track", "gsm8k", "mmlu"]);
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
    expect(a.length).toBe(50 + 20 + 30 + 24 + 200 + 285);
  });

  it("every item is scoreable and has a sane answer", () => {
    for (const item of generateSuite(["qa", "reason", "arith", "track"])) {
      expect(item.answer.length).toBeGreaterThan(0);
      expect(item.prompt.length).toBeGreaterThan(0);
    }
  });
});

describe("prefill helpers", () => {
  it("builds unique prefixes with fresh salts", () => {
    const a = buildPrefillPrompt(4096, "salt1");
    const b = buildPrefillPrompt(4096, "salt2");
    expect(a).not.toBe(b);
    expect(a.startsWith("[prefill-bench salt1]")).toBe(true);
    expect(a.length).toBeGreaterThan(4096);
  });

  it("uses fewer repeats for large contexts", () => {
    expect(repeatsForSize(4096)).toBe(3);
    expect(repeatsForSize(32768)).toBe(3);
    expect(repeatsForSize(131072)).toBe(2);
    expect(repeatsForSize(262144)).toBe(1);
  });

  it("bounds the per-size timeout", () => {
    expect(timeoutMsForSize(0)).toBe(90_000);
    expect(timeoutMsForSize(300_000)).toBe(60_000 + 300_000 * 8);
    expect(timeoutMsForSize(400_000)).toBe(2_700_000);
    expect(timeoutMsForSize(10_000)).toBe(60_000 + 10_000 * 8);
  });

  it("rates from server timings verbatim", () => {
    const s = rateFromSample({ promptTokens: 1000, cachedTokens: 0, ttftMs: 100, serverPromptMs: 100, serverPromptN: 2000 });
    expect(s.method).toBe("server");
    expect(s.prefillTps).toBe(20000);
    expect(s.lowConfidence).toBe(false);
  });

  it("rates from TTFT minus calibrated overhead, capped and flagged", () => {
    const s = rateFromSample({ promptTokens: 1000, cachedTokens: 100, ttftMs: 900, serverPromptMs: null, serverPromptN: null }, 100);
    expect(s.method).toBe("ttft");
    expect(s.prefillTps).toBe(1125); // 900 computed / 800 effective
    // Overhead capped at 50% of TTFT.
    const capped = rateFromSample({ promptTokens: 1000, cachedTokens: 0, ttftMs: 100, serverPromptMs: null, serverPromptN: null }, 500);
    expect(capped.prefillTps).toBe(20_000); // 1000 tokens / 50ms effective
    // Overhead > 30% of TTFT flags low confidence.
    expect(capped.lowConfidence).toBe(true);
  });

  it("explains zero rates", () => {
    const cached = rateFromSample({ promptTokens: 100, cachedTokens: 100, ttftMs: 10, serverPromptMs: null, serverPromptN: null });
    expect(cached.prefillTps).toBe(0);
    expect(cached.reason).toContain("prefix cache");
    const noTtft = rateFromSample({ promptTokens: 100, cachedTokens: 0, ttftMs: 0, serverPromptMs: null, serverPromptN: null });
    expect(noTtft.prefillTps).toBe(0);
    expect(noTtft.reason).toContain("No first token");
  });
});

describe("decode prompts", () => {
  it("are distinct per stream index", () => {
    const prompts = [0, 1, 2, 3].map((i) => decodePrompt("structured", i));
    expect(new Set(prompts).size).toBe(4);
    // Code tasks wrap after 8 with a variant suffix, so all stay distinct.
    expect(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => decodePrompt("code", i))).size).toBe(9);
  });
});

describe("LiveRate", () => {
  it("reports tokens over the rolling window and null when idle", () => {
    let t = 1000;
    const rates: Array<number | null> = [];
    const live = new LiveRate(
      2,
      (tps) => rates.push(tps),
      1000,
      2000,
      () => t,
    );
    live.note(0, 10); // note() sets the stream's cumulative token count
    live.tick(); // t=1000: window degenerate, no reading yet
    t += 1000;
    live.note(0, 30);
    live.note(1, 10);
    live.tick(); // 40 tokens across streams over the 1s since the zero sample
    live.stop();
    expect(rates[rates.length - 2]).toBe(40);
  });
});

describe("runDecode e2e against the fixture server", () => {
  it("sweeps waves and measures tok/s from its own streams", async () => {
    handler = () => ({ events: streamEvents("x".repeat(10), { completion_tokens: 41, prompt_tokens: 10 }) });
    const result = await runDecode(
      { host: "127.0.0.1", port, model: null, concurrencies: [1, 2], maxTokens: 64, promptType: "structured" },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    expect(result.levels).toHaveLength(2);
    expect(result.levels[0]!.concurrency).toBe(1);
    expect(result.levels[1]!.concurrency).toBe(2);
    for (const level of result.levels) {
      expect(level.error).toBeNull();
      expect(level.streamsOk).toBe(level.concurrency);
      // 41 completion tokens/stream: the first is prefill's outcome, so
      // decode tokens exclude it while the completion total does not.
      expect(level.totalDecodeTokens).toBe(40 * level.concurrency);
      expect(level.totalCompletionTokens).toBe(41 * level.concurrency);
      expect(level.meanDecodeTps).toBeGreaterThan(0);
      expect(level.meanTtftMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("records per-stream failures without killing the wave", async () => {
    handler = (body) => {
      const prompt = (body.messages as Array<{ content: string }>)[0]!.content;
      if (prompt.includes("from 1 to")) return { status: 400, events: [] };
      return { events: streamEvents("y".repeat(5), { completion_tokens: 30, prompt_tokens: 8 }) };
    };
    const result = await runDecode(
      { host: "127.0.0.1", port, model: null, concurrencies: [2], maxTokens: 64, promptType: "structured" },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    expect(result.levels[0]!.streamsOk).toBe(1);
    expect(result.levels[0]!.streamsFailed).toBe(1);
  });
});

describe("runPrefill e2e against the fixture server", () => {
  it("sweeps sizes with per-sample rates", async () => {
    handler = () => ({ events: streamEvents("OK", { completion_tokens: 8, prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 } }) });
    const result = await runPrefill(
      { host: "127.0.0.1", port, model: null, sizes: [1024, 4096] },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    expect(result.sizes).toHaveLength(2);
    expect(result.sizes[0]!.tokens).toBe(1024);
    expect(result.sizes[0]!.repeats).toBe(3);
    expect(result.sizes[1]!.repeats).toBe(3);
    for (const size of result.sizes) {
      expect(size.samples.length).toBe(size.repeats);
      expect(size.medianTps).toBeGreaterThan(0);
      // Prompts are salted per request: the fixture saw distinct prefixes.
      const seen = new Set(size.samples.map((s) => s.promptTokens));
      expect(seen.size).toBe(1); // same target size each time
    }
  });
});

describe("runTooleval e2e against the fixture server", () => {
  it("runs trials with simulated tools and scores them", async () => {
    handler = (body) => {
      const messages = body.messages as Array<Record<string, unknown>>;
      const prompt = typeof messages[0]!.content === "string" ? (messages[0]!.content as string) : "";
      const lastRole = messages[messages.length - 1]!.role;
      if (prompt.startsWith("What is the current weather in Lisbon")) {
        if (lastRole === "user") return { events: [{ __json: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Lisbon"}' } }] } }] };
        return { events: [{ __json: { content: "It is 24 degrees, clear." } }] };
      }
      if (prompt.startsWith("What is (18 * 7) + 22")) {
        if (lastRole === "user") return { events: [{ __json: { content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "calculator", arguments: '{"expression":"(18 * 7) + 22"}' } }] } }] };
        return { events: [{ __json: { content: "That is 148." } }] };
      }
      if (prompt.startsWith("Delete the file")) {
        return { events: [{ __json: { content: "I cannot delete files without confirmation." } }] };
      }
      if (prompt.startsWith("What is 12 + 13")) {
        return { events: [{ __json: { content: "25" } }] };
      }
      if (prompt.startsWith("What time is it right now in Asia/Tokyo")) {
        // Wrong tool on turn 1, then a final answer missing the needle → fail.
        return { events: [{ __json: { content: "I do not know." } }] };
      }
      // Default: no tools, empty answer → scenario checks fail.
      return { events: [{ __json: { content: "" } }] };
    };
    const result = await runTooleval(
      { host: "127.0.0.1", port, model: null },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    expect(result.scenarios).toHaveLength(TOOLEVAL_SCENARIOS.length);
    const byId = new Map(result.scenarios.map((s) => [s.id, s]));
    expect(byId.get("TS-01")!.pass).toBe(true);
    expect(byId.get("TP-02")!.pass).toBe(true);
    expect(byId.get("TS-05")!.pass).toBe(true);
    expect(byId.get("TN-01")!.pass).toBe(true);
    expect(byId.get("TS-02")!.pass).toBe(false);
    expect(result.total).toBe(TOOLEVAL_SCENARIOS.length);
  });
});

describe("checkArgs", () => {
  it("matches numbers numerically and strings strictly", () => {
    expect(checkArgs({ amount: 250, from: "EUR", to: "USD" }, { amount: 250, from: "EUR", to: "USD" })).toBe(true);
    expect(checkArgs({ amount: "250" }, { amount: 250 })).toBe(true);
    expect(checkArgs({ amount: 251 }, { amount: 250 })).toBe(false);
    expect(checkArgs({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(checkArgs({ a: 1, b: 2 }, { a: 1 })).toBe(true); // subset
  });
});

describe("BenchRunner", () => {
  it("rejects a second concurrent bench and cancels the first", async () => {
    handler = () => ({ events: streamEvents("x".repeat(5), { completion_tokens: 20, prompt_tokens: 5 }) });
    const done: Array<{ runId: string; status: string; error: string | null }> = [];
    const runner = new BenchRunner({
      onProgress: () => {},
      onDone: (runId, status, _result, error) => done.push({ runId, status, error }),
    });
    const cfg = { host: "127.0.0.1", port, model: null, concurrencies: [1], maxTokens: 64 };
    expect(runner.start({ runId: "r1", bench: "decode", config: cfg })).toBe(true);
    expect(runner.start({ runId: "r2", bench: "decode", config: cfg })).toBe(false);
    runner.cancel("r1");
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.activeRunId).toBeNull();
    expect(done).toEqual([{ runId: "r1", status: "canceled", error: null }]);
  });

  it("fails fast on an invalid config", async () => {
    const done: Array<{ runId: string; status: string; error: string | null }> = [];
    const runner = new BenchRunner({
      onProgress: () => {},
      onDone: (runId, status, _result, error) => done.push({ runId, status, error }),
    });
    expect(runner.start({ runId: "r3", bench: "decode", config: { host: "127.0.0.1", port, maxTokens: 8 } })).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(done[0]!.status).toBe("failed");
    expect(done[0]!.error).toContain("invalid config");
  });
});
