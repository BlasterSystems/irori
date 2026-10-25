import { describe, expect, it } from "vitest";
import { CURRENCIES, CURRENCY_SYMBOL, energyCostPutSchema, tokenCostPutSchema } from "../src/cost.js";

describe("cost settings schemas", () => {
  it("accepts a valid energy price and normalizes nothing", () => {
    const parsed = energyCostPutSchema.parse({ pricePerKwh: 0.35, currency: "EUR" });
    expect(parsed.pricePerKwh).toBe(0.35);
    expect(parsed.currency).toBe("EUR");
  });

  it("rejects non-positive and oversized energy prices and unknown currencies", () => {
    expect(energyCostPutSchema.safeParse({ pricePerKwh: 0, currency: "EUR" }).success).toBe(false);
    expect(energyCostPutSchema.safeParse({ pricePerKwh: -1, currency: "EUR" }).success).toBe(false);
    expect(energyCostPutSchema.safeParse({ pricePerKwh: 101, currency: "EUR" }).success).toBe(false);
    expect(energyCostPutSchema.safeParse({ pricePerKwh: 0.35, currency: "BTC" }).success).toBe(false);
  });

  it("accepts zero token prices (free tier) and rejects oversize/negative", () => {
    const parsed = tokenCostPutSchema.parse({ input: 0, cached: 0.015, output: 0.6, currency: "USD" });
    expect(parsed.input).toBe(0);
    expect(tokenCostPutSchema.safeParse({ input: -1, cached: 0, output: 0, currency: "EUR" }).success).toBe(false);
    expect(tokenCostPutSchema.safeParse({ input: 0, cached: 0, output: 1001, currency: "EUR" }).success).toBe(false);
    expect(tokenCostPutSchema.safeParse({ input: 0, cached: 0, output: 0, currency: "GBP" }).success).toBe(true);
  });

  it("maps every currency to a display symbol", () => {
    for (const c of CURRENCIES) expect(CURRENCY_SYMBOL[c].length).toBe(1);
  });
});
