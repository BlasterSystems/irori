import { eq } from "drizzle-orm";
import { settings } from "@irori/db";
import type { Db } from "@irori/db";
import { energyCostPutSchema, tokenCostPutSchema, type EnergyCost, type TokenCost } from "@irori/core";

export const ENERGY_COST_KEY = "energy_cost";
export const TOKEN_COST_KEY = "token_cost";

export interface CostService {
  getEnergy(): Promise<EnergyCost | null>;
  setEnergy(cost: EnergyCost): Promise<void>;
  getToken(): Promise<TokenCost | null>;
  setToken(cost: TokenCost): Promise<void>;
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
  };
}
