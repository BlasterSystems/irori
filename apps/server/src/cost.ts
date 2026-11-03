import { desc, eq, sql } from "drizzle-orm";
import { modelPrices, settings } from "@irori/db";
import type { Db } from "@irori/db";
import {
  energyCostPutSchema,
  modelPriceSchema,
  tokenCostPutSchema,
  type Currency,
  type EnergyCost,
  type ModelPrice,
  type TokenCost,
} from "@irori/core";
import type { PricingSnapshot } from "./usage-store.js";

export const ENERGY_COST_KEY = "energy_cost";
export const TOKEN_COST_KEY = "token_cost";

export interface ResolvedPrice {
  input: number;
  cached: number;
  output: number;
  currency: Currency;
}

export interface CostService {
  getEnergy(): Promise<EnergyCost | null>;
  setEnergy(cost: EnergyCost): Promise<void>;
  getToken(): Promise<TokenCost | null>;
  setToken(cost: TokenCost): Promise<void>;
  /** IRI-072: all overrides, newest edit last (settings UI order). */
  listModelPrices(): Promise<ModelPrice[]>;
  /** Upserts one override (exact pattern or prefix). */
  setModelPrice(price: ModelPrice): Promise<void>;
  deleteModelPrice(pattern: string): Promise<void>;
  /**
   * Resolution order: exact name → longest matching prefix → the global
   * token-cost setting → null (no pricing configured; never a fake zero).
   */
  resolvePrice(model: string): Promise<ResolvedPrice | null>;
  /**
   * IRI-072: one pricing load per request — overrides + default fetched once,
   * resolved synchronously per row (a read with 200 groups costs 2 queries).
   */
  snapshot(): Promise<PricingSnapshot>;
  /** Nulls every bucket cost stamp — a price/currency change re-prices
   *  history through the backfill (documented: no price history kept). */
  resetCostStamps(): Promise<void>;
}

/**
 * IRI-025: energy + token cost settings (settings table, like the global HF
 * token and the cadence). get() returns null when unset or when the stored
 * value no longer validates (treated as unset, never trusted).
 */
export function createCostService(db: Db): CostService {
  async function read<T>(key: string, parse: (raw: unknown) => T | null): Promise<T | null> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
    return row?.value === undefined || row?.value === null ? null : parse(row.value);
  }
  async function write(key: string, value: unknown): Promise<void> {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
  return {
    async getEnergy() {
      return read(ENERGY_COST_KEY, (raw) => {
        const parsed = energyCostPutSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      });
    },
    async setEnergy(cost) {
      await write(ENERGY_COST_KEY, cost);
    },
    async getToken() {
      return read(TOKEN_COST_KEY, (raw) => {
        const parsed = tokenCostPutSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      });
    },
    async setToken(cost) {
      await write(TOKEN_COST_KEY, cost);
    },
    async listModelPrices() {
      const rows = await db.select().from(modelPrices).orderBy(desc(modelPrices.pattern));
      return rows.flatMap((row) => {
        const parsed = modelPriceSchema.safeParse({ pattern: row.pattern, input: row.input, cached: row.cached, output: row.output, currency: row.currency });
        return parsed.success ? [parsed.data] : [];
      });
    },
    async setModelPrice(price) {
      const parsed = modelPriceSchema.parse(price);
      await db
        .insert(modelPrices)
        .values({ pattern: parsed.pattern, input: parsed.input, cached: parsed.cached, output: parsed.output, currency: parsed.currency })
        .onConflictDoUpdate({
          target: modelPrices.pattern,
          set: { input: parsed.input, cached: parsed.cached, output: parsed.output, currency: parsed.currency, updatedAt: new Date() },
        });
    },
    async deleteModelPrice(pattern) {
      await db.delete(modelPrices).where(eq(modelPrices.pattern, pattern));
    },
    async resolvePrice(model) {
      const overrides = await this.listModelPrices();
      const exact = overrides.find((o) => o.pattern === model);
      if (exact !== undefined) return exact;
      // Longest prefix wins so "GLM-5.3" cannot shadow "GLM-5.3-Flash".
      const prefixes = overrides
        .filter((o) => model.startsWith(o.pattern))
        .sort((a, b) => b.pattern.length - a.pattern.length);
      if (prefixes.length > 0) return prefixes[0]!;
      const fallback = await this.getToken();
      return fallback;
    },
    async snapshot() {
      const overrides = await this.listModelPrices();
      const fallback = await this.getToken();
      return {
        currency: fallback?.currency ?? null,
        resolve: (model: string): ResolvedPrice | null => {
          const exact = overrides.find((o) => o.pattern === model);
          if (exact !== undefined) return exact;
          const prefixes = overrides.filter((o) => model.startsWith(o.pattern)).sort((a, b) => b.pattern.length - a.pattern.length);
          return prefixes[0] ?? fallback;
        },
      };
    },
    async resetCostStamps() {
      await db.execute(sql`update usage_buckets set cost_minor = null, cost_currency = null where cost_minor is not null`);
    },
  };
}
