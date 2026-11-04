import { createDbHandle } from "@irori/db";
import { createNodeStore } from "@irori/db";

/**
 * IRI-084 hotfix validation: reproduce the live "journal ahead of schema"
 * state on a scratch database, then prove 0027_schema_repair heals it.
 * Run: npx tsx scripts/repro-schema-drift.ts <DATABASE_URL>
 * Creates + drops its own scratch database — never touches other data.
 */
const base = process.argv[2];
if (base === undefined) throw new Error("usage: tsx repro-schema-drift.ts <postgres://user:pass@host:port/postgres>");
const baseNoDb = base.replace(/\/[^/]+$/, "/");
const REPRO = "irori_repro_084";

const admin = createDbHandle(`${baseNoDb}postgres`);
await admin.db.execute(`DROP DATABASE IF EXISTS ${REPRO} WITH (FORCE)`);
await admin.db.execute(`CREATE DATABASE ${REPRO}`);
console.log("scratch db created");

// 1. Full migrate (applies 0001..0027) on the scratch db.
const url = `${baseNoDb}${REPRO}`;
let handle = createDbHandle(url);
await handle.migrate();
console.log("full migrate ok");

// 2. Simulate the live broken state: drop every 0020 object; the journal
// stays AHEAD (says 0020-0027 applied) — exactly the live hub's state.
const dropTables = ["update_baseline_cache", "node_update_reports", "recipe_catalog", "rejected_usage", "community_sources", "community_items", "event_journal", "log_drop_counters", "logs", "health_findings", "health_rules", "alert_deliveries", "alert_channels", "audit_log"];
for (const t of dropTables) await handle.db.execute(`DROP TABLE IF EXISTS ${t} CASCADE`);
await handle.db.execute(`ALTER TABLE nodes DROP COLUMN IF EXISTS wol_mac`);
await handle.db.execute(`ALTER TABLE nodes DROP COLUMN IF EXISTS gpu_clock_cap_mhz`);
await handle.db.execute(`ALTER TABLE nodes DROP COLUMN IF EXISTS gpu_clock_cap_persistent`);
console.log("0020 objects dropped (journal still says applied)");

// 3. The store list now throws — the live /api/v1/nodes 500.
const store = createNodeStore(handle.db, "a".repeat(64));
let threw = false;
try {
  await store.list();
} catch {
  threw = true;
}
console.log("store.list throws on broken schema:", threw);
if (!threw) throw new Error("expected the broken state to throw");

// 4. Drop the 0027 journal row (so the next boot re-applies the repair) and
// re-run the boot migrate — the hub's own recovery path.
await handle.db.execute(`DELETE FROM drizzle.__drizzle_migrations WHERE hash LIKE '%0027%' OR id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`);
handle = createDbHandle(url);
await handle.migrate();
const col = await handle.db.execute(`select column_name from information_schema.columns where table_name='nodes' and column_name='wol_mac'`);
console.log("wol_mac after repair:", JSON.stringify(col).slice(0, 200));
const jrow = await handle.db.execute(`select id, left(hash, 12) as h from drizzle.__drizzle_migrations order by id desc limit 2`);
console.log("journal tail:", JSON.stringify(jrow).slice(0, 200));

// 5. Healed: the store lists cleanly and the 0020 tables are back.
const rows = await store.list();
console.log("store.list ok, rows:", rows.length);
const probe = await handle.db.execute(`select count(*)::int as n from audit_log`);
console.log("audit_log back:", (probe as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? (probe as unknown as { n: number }).n);
await admin.db.execute(`DROP DATABASE IF EXISTS ${REPRO} WITH (FORCE)`);
console.log("scratch db dropped — VALIDATION PASSED");
process.exit(0);
