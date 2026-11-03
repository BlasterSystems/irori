/**
 * IRI-074/076: shared money formatter — minor units + currency code to the
 * display string. Never invents a symbol; unknown currencies render plain.
 */
const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

export function costText(minor: number, currency: string | null): string {
  if (currency === null) return "—";
  const sym = CURRENCY_SYMBOLS[currency] ?? "";
  return `${sym}${(minor / 100).toFixed(2)}`;
}

export function hasCurrency(currency: string | null | undefined): boolean {
  return currency !== null && currency !== undefined;
}
