import { canonicalJson, sha256 } from "../core/canonical.ts";
import { currencyExponent, isCurrencyCode } from "../core/money.ts";
import type { JsonObject, JsonValue } from "../core/types.ts";
import { stripControlText } from "../security/text.ts";

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const TRACKING_PARAMETERS = /^(?:utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid)$/i;

export type ScalarType = "string" | "number" | "integer" | "boolean" | "money";
export type Money = { minor: number; currency: string };

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function array(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

export function cleanText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = stripControlText(String(value)).normalize("NFKC").replace(/\s+/g, " ").trim();
    return text || undefined;
  }
  const object = record(value);
  if (!object) return undefined;
  return cleanText(object["#text"] ?? object["_text"] ?? object["value"]);
}

export function canonicalUrl(value: unknown, base?: string): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  try {
    const url = base === undefined ? new URL(text) : new URL(text, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.test(name)) url.searchParams.delete(name);
    }
    url.searchParams.sort();
    return url.href;
  } catch {
    return undefined;
  }
}

export function normalizeDate(value: unknown): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error("date field is invalid");
  return new Date(milliseconds).toISOString();
}

export function extractDoi(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = cleanText(value);
    if (!text) continue;
    let decoded = text;
    try {
      decoded = decodeURIComponent(text);
    } catch {
      // A malformed percent escape cannot hide a plain DOI match.
    }
    const match = /(?:doi:\s*|doi\.org\/)?(10\.\d{4,9}\/[-._;()/:a-z0-9]+)/i.exec(decoded);
    const doi = match?.[1]?.replace(/[\s.,;:>\]}]+$/g, "").toLowerCase();
    if (doi) return doi;
  }
  return undefined;
}

export function extractArxiv(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = cleanText(value);
    if (!text) continue;
    const match = /(?:arxiv:\s*|arxiv\.org\/(?:abs|pdf)\/)?((?:[a-z][a-z0-9.-]*\/[0-9]{7}|[0-9]{4}\.[0-9]{4,5}))(?:v[0-9]+)?(?:\.pdf)?/i.exec(text);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return undefined;
}

export function stableItemId(input: {
  doi?: unknown;
  arxiv?: unknown;
  url?: unknown;
  explicit?: unknown;
  fallback: JsonValue;
}): string {
  const doi = extractDoi(input.doi, input.url, input.explicit);
  if (doi) return `doi:${doi}`;
  const arxiv = extractArxiv(input.arxiv, input.url, input.explicit);
  if (arxiv) return `arxiv:${arxiv}`;
  const url = canonicalUrl(input.url);
  if (url) return `url:${url}`;
  const explicit = cleanText(input.explicit);
  if (explicit) return `id:${explicit.normalize("NFKC")}`;
  return `sha256:${sha256(canonicalJson(input.fallback))}`;
}

export function safePath(path: string): string[] {
  if (!path || path.startsWith(".") || path.endsWith(".")) throw new Error(`invalid dotted path: ${path}`);
  const segments = path.split(".");
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_$-]+$/.test(segment) || segment === "$" || UNSAFE_PATH_SEGMENTS.has(segment)) {
      throw new Error(`unsafe dotted path segment: ${segment}`);
    }
  }
  return segments;
}

export function getPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of safePath(path)) {
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(segment)) return undefined;
      cursor = cursor[Number(segment)];
      continue;
    }
    const object = record(cursor);
    if (!object || !Object.hasOwn(object, segment)) return undefined;
    cursor = object[segment];
  }
  return cursor;
}

export function setPath(object: JsonObject, path: string, value: JsonValue): void {
  const segments = safePath(path);
  let cursor = object;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    const existing = cursor[segment];
    if (existing === undefined) {
      const child: JsonObject = {};
      cursor[segment] = child;
      cursor = child;
      continue;
    }
    if (existing === null || Array.isArray(existing) || typeof existing !== "object") {
      throw new Error(`mapped field path collides at ${segment}`);
    }
    cursor = existing;
  }
}

export function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJson);
  const object = record(value);
  if (!object) return String(value);
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(object)) {
    if (UNSAFE_PATH_SEGMENTS.has(key) || child === undefined || typeof child === "function" || typeof child === "symbol") continue;
    result[key] = toJson(child);
  }
  return result;
}

export function coerce(value: unknown, type?: ScalarType, currency?: string): JsonValue {
  if (type === undefined) return toJson(value);
  if (type === "money") return parseMoney(value, currency);
  if (type === "string") return cleanText(value) ?? "";
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const text = cleanText(value)?.toLowerCase();
    if (["true", "yes", "y", "1", "on"].includes(text ?? "")) return true;
    if (["false", "no", "n", "0", "off"].includes(text ?? "")) return false;
    throw new Error("cannot parse boolean field");
  }
  const number = typeof value === "number" ? value : Number(cleanText(value)?.replace(/,/g, ""));
  if (!Number.isFinite(number)) throw new Error("cannot parse numeric field");
  if (type === "integer" && !Number.isSafeInteger(number)) throw new Error("numeric field is not a safe integer");
  return number;
}

export function parseMoney(value: unknown, configuredCurrency?: string): Money {
  const existing = record(value);
  if (existing && typeof existing["minor"] === "number" && typeof existing["currency"] === "string") {
    const minor = existing["minor"];
    const currency = existing["currency"].toUpperCase();
    if (!Number.isSafeInteger(minor) || minor < 0 || !isCurrencyCode(currency)) throw new Error("invalid money object");
    if (configuredCurrency && configuredCurrency !== currency) throw new Error(`money currency ${currency} does not match ${configuredCurrency}`);
    return { minor, currency };
  }

  const text = cleanText(value);
  const signals = text ? currencySignals(text) : new Set<string>();
  if (signals.size > 1) throw new Error("money text contains conflicting currencies");
  const inferred = signals.values().next().value as string | undefined;
  const configured = configuredCurrency?.toUpperCase();
  if (configured && !isCurrencyCode(configured)) throw new Error("money uses an unsupported ISO 4217 currency code");
  if (configured && inferred && configured !== inferred) {
    throw new Error(`money currency ${inferred} does not match ${configured}`);
  }
  const currency = configured ?? inferred;
  if (!currency || !isCurrencyCode(currency)) throw new Error("money requires an explicit ISO 4217 currency");
  const exponent = currencyExponent(currency);

  if (typeof value === "number") {
    const minor = Math.round(value * 10 ** exponent);
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(minor)) throw new Error("money amount is outside the safe range");
    return { minor, currency };
  }
  if (!text) throw new Error("money amount is empty");
  if (/[-\u2212\u2010-\u2015\uFE63\uFF0D]|\([^)]*\)/u.test(text)) throw new Error("money amount must be non-negative");

  const candidates = text.match(/[0-9][0-9.,]*/g) ?? [];
  if (candidates.length !== 1) throw new Error("money text must contain exactly one numeric amount");
  const numeric = candidates[0]!;
  if (!/[0-9]/.test(numeric)) throw new Error("money text contains no numeric amount");
  const decimal = decimalSeparator(numeric, exponent);
  const splitAt = decimal ? numeric.lastIndexOf(decimal) : -1;
  const wholeDigits = (splitAt < 0 ? numeric : numeric.slice(0, splitAt)).replace(/[.,]/g, "") || "0";
  const fractionDigits = splitAt < 0 ? "" : numeric.slice(splitAt + 1).replace(/[.,]/g, "");
  let minor = BigInt(wholeDigits) * 10n ** BigInt(exponent);
  if (exponent > 0) {
    const kept = fractionDigits.slice(0, exponent).padEnd(exponent, "0");
    minor += BigInt(kept || "0");
    if (fractionDigits.length > exponent && Number(fractionDigits[exponent]) >= 5) minor += 1n;
  }
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("money amount is outside the safe range");
  return { minor: Number(minor), currency };
}

function currencySignals(text: string): Set<string> {
  const signals = new Set<string>();
  for (const match of text.matchAll(/(?:^|[^A-Z])([A-Z]{3})(?=$|[^A-Z])/giu)) {
    const code = match[1]?.toUpperCase();
    if (code && isCurrencyCode(code)) signals.add(code);
  }
  for (const [symbol, code] of [["€", "EUR"], ["£", "GBP"], ["¥", "JPY"], ["￥", "JPY"], ["₩", "KRW"], ["₹", "INR"], ["$", "USD"]] as const) {
    if (text.includes(symbol)) signals.add(code);
  }
  return signals;
}

function decimalSeparator(numeric: string, exponent: number): "." | "," | undefined {
  if (exponent === 0) return undefined;
  const dot = numeric.lastIndexOf(".");
  const comma = numeric.lastIndexOf(",");
  if (dot >= 0 && comma >= 0) return dot > comma ? "." : ",";
  const index = Math.max(dot, comma);
  if (index < 0) return undefined;
  const separator = dot >= 0 ? "." : ",";
  const occurrences = numeric.split(separator).length - 1;
  const trailing = numeric.length - index - 1;
  return occurrences === 1 && trailing > 0 && trailing <= exponent ? separator : undefined;
}

export function stringAt(data: JsonObject, ...paths: string[]): string | undefined {
  for (const path of paths) {
    const value = getPath(data, path);
    const text = cleanText(value);
    if (text) return text;
  }
  return undefined;
}
