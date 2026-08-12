const CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));

export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value) && CURRENCY_CODES.has(value);
}

export function currencyExponent(currency: string): number {
  if (!isCurrencyCode(currency)) throw new Error("unsupported ISO 4217 currency code");
  return new Intl.NumberFormat("en", { style: "currency", currency })
    .resolvedOptions().maximumFractionDigits ?? 2;
}

export function formatMinorUnits(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  return `${(minor / 10 ** exponent).toFixed(exponent)} ${currency}`;
}
