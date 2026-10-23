import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, settings, type DbHandle } from "@irori/db";
import { createHfTokenService, HF_TOKEN_KEY } from "../src/hf-token.js";

/**
 * IRI-019: the global HF token settings row. Requires a REAL Postgres
 * (ADR-0002) — same convention as m7.test.ts: IRORI_TEST_DATABASE_URL at a
 * DISPOSABLE database; CI starts the container.
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("hf token service (db integration)", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
  });
  afterAll(() => handle?.close());

  it("round-trips set/get/overwrite/clear", async () => {
    const svc = createHfTokenService(handle.db);
    await svc.set(null); // clean slate for re-runs
    expect(await svc.get()).toBeNull();

    await svc.set("hf_a");
    expect(await svc.get()).toBe("hf_a");
    await svc.set("hf_b");
    expect(await svc.get()).toBe("hf_b");
    await svc.set(null);
    expect(await svc.get()).toBeNull();
  });

  it("treats a stored empty string as unset", async () => {
    const svc = createHfTokenService(handle.db);
    await handle.db
      .insert(settings)
      .values({ key: HF_TOKEN_KEY, value: "" })
      .onConflictDoUpdate({ target: settings.key, set: { value: "" } });
    expect(await svc.get()).toBeNull();
    await svc.set(null); // leave the row deleted for other suites
  });
});
