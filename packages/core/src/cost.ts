import { z } from "zod";

/**
 * Cost settings (IRI-025): the energy price (€/kWh) behind the Overview power
 * cost estimate and the per-million-token prices behind the token cost
 * preview. One shared currency feeds both. Persisted as settings rows by the
 * server (apps/server/src/cost.ts) — null means "not configured" everywhere.
 */

export const CURRENCIES = ["EUR", "USD", "GBP"] as const;
export const currencySchema = z.enum(CURRENCIES);
export type Currency = (typeof CURRENCIES)[number];

/** Display symbol for the cost stats and the settings selects. */
export const CURRENCY_SYMBOL: Record<Currency, string> = { EUR: "€", USD: "$", GBP: "£" };

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
