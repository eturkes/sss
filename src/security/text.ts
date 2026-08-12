const TERMINAL_SEQUENCES =
  /(?:\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[P^_][\s\S]*?\u001B\\|\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B[@-_])/g;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const DIRECTIONAL_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s<>"']+/giu;
const AUTHORIZATION = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/giu;
const SECRET_ASSIGNMENT =
  /(\b(?:api[-_]?key|authorization|credential|password|passwd|secret|signature|token)\b\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const JSON_SECRET =
  /("(?:api[-_]?key|authorization|credential|password|passwd|secret|signature|token)"\s*:\s*)"(?:\\.|[^"\\])*"/giu;
const PRIVATE_KEY = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;

/** Removes terminal escapes and display-affecting controls while preserving tabs/newlines. */
export function stripControlText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(TERMINAL_SEQUENCES, "")
    .replace(CONTROL_CHARACTERS, "")
    .replace(DIRECTIONAL_CONTROLS, "");
}

/** Produces a diagnostic URL: origin visible; credentials, path, query, fragment opaque. */
export function redactUrl(value: string | URL): string {
  try {
    const url = new URL(value instanceof URL ? value.href : value);
    const path = url.pathname === "/" ? "/" : "/[REDACTED]";
    const query = url.search.length === 0 ? "" : "?[REDACTED]";
    const fragment = url.hash.length === 0 ? "" : "#[REDACTED]";
    return `${url.protocol}//${url.host}${path}${query}${fragment}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

/** Best-effort log boundary: de-terminalize first so escapes cannot split secret markers. */
export function redactSecrets(value: string): string {
  return stripControlText(value)
    .replace(PRIVATE_KEY, "[REDACTED_PRIVATE_KEY]")
    .replace(ABSOLUTE_URL, (url) => redactUrl(url))
    .replace(JSON_SECRET, "$1\"[REDACTED]\"")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(AUTHORIZATION, "$1 [REDACTED]")
    .replace(JWT, "[REDACTED_JWT]");
}

export function safeErrorMessage(error: unknown, maxLength = 1_000): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const safe = redactSecrets(raw);
  return safe.length <= maxLength ? safe : `${safe.slice(0, maxLength)}…`;
}

type BodyCarrier = { readonly body: Uint8Array };

/** Decodes acquired bytes without implicit HTML parsing or content transformation. */
export function text(value: Uint8Array | BodyCarrier, encoding = "utf-8"): string {
  const bytes = value instanceof Uint8Array ? value : value.body;
  return new TextDecoder(encoding, { fatal: false }).decode(bytes);
}

export const decodeText = text;
