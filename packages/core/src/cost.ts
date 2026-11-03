import { z } from "zod";
import { usageRangeSchema } from "./usage-api.js";
import { CURRENCIES, CURRENCY_SYMBOL, currencySchema, type Currency } from "./currency.js";

export { CURRENCIES, currencySchema, CURRENCY_SYMBOL };
export type { Currency };

/**
 * Cost settings (IRI-025): the energy price (€/kWh) behind the Overview power
 * cost estimate and the per-million-token prices behind the token cost
 * preview. One shared currency feeds both. Persisted as settings rows by the
 * server (apps/server/src/cost.ts) — null means "not configured" everywhere.
 */

export const energyCostPutSchema = z.object({
  /** Price per kWh; 0 is meaningless, the cap keeps typos out of the UI. */
  pricePerKwh: z.number().positive().max(100),
  currency: currencySchema,
});
export type EnergyCost = z.infer<typeof energyCostPutSchema>;
export type EnergyCostInput = z.input<typeof energyCostPutSchema>;

export const tokenCostPutSchema = z.object({
  /** Per-million-token prices: billable input (prompt minus cached), cached
   *  prefix hits and generated output. Zero is valid (free tier). */
  input: z.number().nonnegative().max(1000),
  cached: z.number().nonnegative().max(1000),
  output: z.number().nonnegative().max(1000),
  currency: currencySchema,
});
export type TokenCost = z.infer<typeof tokenCostPutSchema>;
export type TokenCostInput = z.input<typeof tokenCostPutSchema>;

/** GET response envelopes (web client parses with these). */
export const energyCostResponseSchema = z.object({ energyCost: energyCostPutSchema.nullable() });
export type EnergyCostResponse = z.infer<typeof energyCostResponseSchema>;
export const tokenCostResponseSchema = z.object({ tokenCost: tokenCostPutSchema.nullable() });
export type TokenCostResponse = z.infer<typeof tokenCostResponseSchema>;

/* ── IRI-072: the single cost implementation (server-side) ─────────────── */

export interface TokenSums {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/**
 * Cost of a token sum in MINOR units (cents) of the price's currency, with
 * the exact IRI-025 semantics: billable input is (prompt − cached) at the
 * input price, cached prefix hits at the cached price, output at the output
 * price; all per million tokens. Rounding happens ONCE per aggregate —
 * callers sum unrounded buckets, never minor units, so no drift accumulates.
 * null when pricing is unset: a missing price is "unknown", never a fake 0.
 */
export function tokenCostMinor(sums: TokenSums, price: TokenCostInput | TokenCost | null | undefined): number | null {
  if (price === null || price === undefined) return null;
  const prompt = Math.max(0, sums.promptTokens - sums.cachedTokens);
  const exact =
    ((prompt * price.input + sums.cachedTokens * price.cached + sums.completionTokens * price.output) / 1_000_000) * 100;
  if (!Number.isFinite(exact)) return null;
  return Math.round(exact);
}

/** Minor units → human string with the shared symbol (web formatting only). */
export function fmtMinor(minor: number, currency: Currency): string {
  const symbol = CURRENCY_SYMBOL[currency];
  return `${symbol}${(minor / 100).toFixed(2)}`;
}

/** Per-model price override (IRI-072): exact name match beats the longest
 *  prefix; the default is the global token-cost setting. */
export const modelPriceSchema = z.object({
  /** Exact model name or a prefix ("GLM-5.3" matches "GLM-5.3-Flash-EXL3"). */
  pattern: z.string().min(1).max(200),
  input: z.number().nonnegative().max(1000),
  cached: z.number().nonnegative().max(1000),
  output: z.number().nonnegative().max(1000),
  currency: currencySchema,
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

export const modelPricePutSchema = modelPriceSchema;
export type ModelPricePut = z.infer<typeof modelPricePutSchema>;

export const modelPricesResponseSchema = z.object({ prices: z.array(modelPriceSchema) });
export type ModelPricesResponse = z.infer<typeof modelPricesResponseSchema>;

export const usageCostGroupBySchema = z.enum(["model", "client", "setup", "day", "node"]);
export type UsageCostGroupBy = z.infer<typeof usageCostGroupBySchema>;

/** GET /api/v1/usage/cost — cost rows per group; `costMinor` sums the exact
 *  unrounded per-bucket costs then rounds once (consistent with the rows). */
export const usageCostResponseSchema = z.object({
  range: usageRangeSchema,
  groupBy: usageCostGroupBySchema,
  /** null when no pricing was configured anywhere in the window. */
  currency: currencySchema.nullable(),
  rows: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      costMinor: z.number().int().nonnegative(),
      requests: z.number().int().nonnegative(),
      promptTokens: z.number(),
      completionTokens: z.number(),
      cachedTokens: z.number(),
    }),
  ),
  totalMinor: z.number().int().nonnegative(),
});
export type UsageCostResponse = z.infer<typeof usageCostResponseSchema>;
