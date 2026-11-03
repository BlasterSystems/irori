import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbHandle, llmRequests, nodes, tokenLedger, type Db, type DbHandle } from "@irori/db";
import { createAnalyticsService } from "../src/analytics.js";

/**
 * IRI-071 (IR-162): token reconciliation — the engine-counter ledger vs the
 * captured llm_requests, per node/port/model, with the divergence warn chip
 * gated on BOTH sides having data. Deliberately divergent fixtures.
 */

const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("token reconciliation (db integration)", () => {
  let handle: DbHandle;
  let db: Db;
  let nodeId: string;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    await db.delete(tokenLedger);
    await db.delete(llmRequests);
    await db.delete(nodes);
    await db.insert(nodes).values({ id: nodeId, name: "recon", kind: "spark", role: "standalone", host: "localhost", agentTokenHash: "x", agentTokenEnc: "x" });
  });

  afterAll(async () => {
    await db.delete(nodes);
    await handle.close();
  });

  it("pairs both sources, flags >20% divergence, and hides the chip when a side is empty", async () => {
    const now = Date.now();
    const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000);
    // Ledger: 1000 generated + 500 prompt on port 8081 (agrees with capture),
    // 10_000 on port 8082 (diverges from 1_000 captured).
    await db.insert(tokenLedger).values([
      { nodeId, port: 8081, model: "glm", granularity: "hour", bucketStart: hour, generatedTokens: 1000, promptTokens: 500, generatedSeen: true, promptSeen: true },
      { nodeId, port: 8082, model: "qwen", granularity: "hour", bucketStart: hour, generatedTokens: 10_000, promptTokens: 0, generatedSeen: true },
    ]);
    // Capture: 8081 agrees (1500); 8082 has 1_000 (divergence 90%).
    await db.insert(llmRequests).values([
      { id: randomUUID(), nodeId, port: 8081, ts: new Date(now), model: "glm", endpoint: "/v1/chat/completions", stream: false, status: 200, promptTokens: 500, completionTokens: 1000, error: null, errorSig: null, durationMs: 10 },
      { id: randomUUID(), nodeId, port: 8082, ts: new Date(now), model: "qwen", endpoint: "/v1/chat/completions", stream: false, status: 200, promptTokens: 0, completionTokens: 1000, error: null, errorSig: null, durationMs: 10 },
    ]);

    const service = createAnalyticsService(db);
    const recon = await service.reconciliation({ range: "24h", nodeId });
    expect(recon.rows).toHaveLength(2);
    const agree = recon.rows.find((r) => r.port === 8081)!;
    expect(agree.ledgerTokens).toBe(1500);
    expect(agree.captureTokens).toBe(1500);
    expect(agree.warn).toBe(false);
    expect(agree.costsUse).toBe("capture");

    const diverge = recon.rows.find((r) => r.port === 8082)!;
    expect(diverge.ledgerTokens).toBe(10_000);
    expect(diverge.captureTokens).toBe(1000);
    expect(diverge.delta).toBe(9000);
    expect(diverge.warn).toBe(true);
    expect(diverge.divergencePct).toBe(90);
  });
});
