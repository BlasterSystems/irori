import { z } from "zod";

/**
 * Shared currency primitives (IRI-072 leaf module): both `cost.ts` and
 * `usage-api.ts` need the enum, and a leaf keeps that pair from forming a
 * runtime import cycle (zod schema objects are evaluated at import time).
 */

export const CURRENCIES = ["EUR", "USD", "GBP"] as const;
export const currencySchema = z.enum(CURRENCIES);
export type Currency = (typeof CURRENCIES)[number];

/** Display symbol for the cost stats and the settings selects. */
export const CURRENCY_SYMBOL: Record<Currency, string> = { EUR: "€", USD: "$", GBP: "£" };
