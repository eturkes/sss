import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, errors, request as undiciRequest } from "undici";
import { redactUrl, safeErrorMessage, stripControlText } from "./text.ts";

export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_REDIRECTS = 5;

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 10;
const MAX_DNS_ANSWERS = 32;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PRIVATE_RANGES = new Set([
  "private",
  "loopback",
  "uniqueLocal",
]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);
const CROSS_ORIGIN_SECRET_HEADER =
  /^(?:authorization|cookie|proxy-authorization|set-cookie|.*(?:api[-_]?key|auth|credential|secret|signature|token).*)$/iu;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export type NetworkErrorCode =
  | "SSS_BODY_TOO_LARGE"
  | "SSS_DNS_REJECTED"
  | "SSS_OPTIONS_INVALID"
  | "SSS_REDIRECT_REJECTED"
  | "SSS_REQUEST_FAILED"
  | "SSS_TIMEOUT"
  | "SSS_URL_REJECTED";

export class NetworkSecurityError extends Error {
  readonly code: NetworkErrorCode;

  constructor(code: NetworkErrorCode, message: string) {
    super(message);
    this.name = "NetworkSecurityError";
    this.code = code;
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface ValidateTargetOptions {
  readonly resolver?: Resolver;
  readonly allowPrivate?: boolean;
}

export interface ValidatedTarget {
  readonly url: URL;
  readonly addresses: readonly ResolvedAddress[];
}

interface CommonRequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxBodyBytes?: number;
  readonly maxRedirects?: number;
  readonly redirectAllowlist?: readonly string[];
  readonly resolver?: Resolver;
  readonly timeoutMs?: number;
}

export interface ReadRequestOptions extends CommonRequestOptions {
  readonly method?: "GET" | "HEAD";
  readonly allowPrivate?: false;
  readonly body?: never;
  readonly trustedSink?: never;
}

export interface TrustedPostRequestOptions extends CommonRequestOptions {
  readonly method: "POST";
  readonly allowPrivate: boolean;
  readonly body?: string | Uint8Array;
  readonly trustedSink: true;
}

export type SafeRequestOptions = ReadRequestOptions | TrustedPostRequestOptions;

export interface SafeResponse {
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
}

const defaultResolver: Resolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

function policyError(code: NetworkErrorCode, message: string): NetworkSecurityError {
  return new NetworkSecurityError(code, message);
}

function parseUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value instanceof URL ? value.href : value);
  } catch {
    throw policyError("SSS_URL_REJECTED", "Invalid target URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw policyError("SSS_URL_REJECTED", "Target protocol must be HTTP or HTTPS");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw policyError("SSS_URL_REJECTED", "Target URL credentials are forbidden");
  }
  if (url.hostname.length === 0) {
    throw policyError("SSS_URL_REJECTED", "Target URL requires a hostname");
  }
  return url;
}

function bareHostname(hostname: string): string {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return unbracketed.endsWith(".") ? unbracketed.slice(0, -1).toLowerCase() : unbracketed.toLowerCase();
}

function parseAddress(value: string): { address: string; family: 4 | 6; range: string } | undefined {
  const candidate = bareHostname(value);
  try {
    const parsed = ipaddr.process(candidate);
    return {
      address: parsed.toString(),
      family: parsed.kind() === "ipv4" ? 4 : 6,
      range: parsed.range(),
    };
  } catch {
    return undefined;
  }
}

export function isGlobalAddress(value: string): boolean {
  return parseAddress(value)?.range === "unicast";
}

function isAllowedAddress(value: string, allowPrivate: boolean): boolean {
  const parsed = parseAddress(value);
  if (parsed === undefined) return false;
  if (parsed.range === "unicast") return true;
  return allowPrivate && PRIVATE_RANGES.has(parsed.range);
}

function normalizeAnswers(
  answers: readonly ResolvedAddress[],
  allowPrivate: boolean,
): readonly ResolvedAddress[] {
  if (answers.length === 0 || answers.length > MAX_DNS_ANSWERS) {
    throw policyError("SSS_DNS_REJECTED", "Target DNS answer set is unusable");
  }

  const normalized = new Map<string, ResolvedAddress>();
  for (const answer of answers) {
    if (answer.family !== 4 && answer.family !== 6) {
      throw policyError("SSS_DNS_REJECTED", "Target DNS answer is invalid");
    }
    const parsed = parseAddress(answer.address);
    if (parsed === undefined || !isAllowedAddress(answer.address, allowPrivate)) {
      throw policyError("SSS_DNS_REJECTED", "Target resolves to a disallowed address");
    }
    normalized.set(`${parsed.family}:${parsed.address}`, Object.freeze({
      address: parsed.address,
      family: parsed.family,
    }));
  }
  return Object.freeze([...normalized.values()]);
}

export async function validateTarget(
  value: string | URL,
  options: ValidateTargetOptions = {},
): Promise<ValidatedTarget> {
  const url = parseUrl(value);
  const hostname = bareHostname(url.hostname);
  const literal = parseAddress(hostname);
  let answers: readonly ResolvedAddress[];

  if (literal !== undefined) {
    answers = [{ address: literal.address, family: literal.family }];
  } else {
    try {
      answers = await (options.resolver ?? defaultResolver)(hostname);
    } catch (error) {
      if (error instanceof NetworkSecurityError) throw error;
      throw policyError("SSS_DNS_REJECTED", "Target DNS resolution failed");
    }
  }

  return Object.freeze({
    url,
    addresses: normalizeAnswers(answers, options.allowPrivate === true),
  });
}

function integerOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
  allowZero = false,
): number {
  const result = value ?? fallback;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw policyError("SSS_OPTIONS_INVALID", `${name} is outside its safe range`);
  }
  return result;
}

function requestHeaders(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = rawName.toLowerCase();
    if (!HEADER_NAME.test(name) || FORBIDDEN_REQUEST_HEADERS.has(name)) {
      throw policyError("SSS_OPTIONS_INVALID", "Request contains a forbidden header name");
    }
    if (/[\u0000-\u0008\u000A-\u001F\u007F]/u.test(value)) {
      throw policyError("SSS_OPTIONS_INVALID", "Request contains an invalid header value");
    }
    result[name] = value;
  }
  result["accept-encoding"] = "identity";
  result["user-agent"] ??= "Super-Smart-Scanner/0.1 (personal web monitor)";
  return result;
}

function allowedRedirectOrigins(input: readonly string[] | undefined): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of input ?? []) {
    const url = parseUrl(value);
    if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
      throw policyError("SSS_OPTIONS_INVALID", "Redirect allowlist entries must be exact origins");
    }
    result.add(url.origin);
  }
  return result;
}

function pinnedLookup(expectedHostname: string, answers: readonly ResolvedAddress[]): LookupFunction {
  return (hostname, options, callback) => {
    if (bareHostname(hostname) !== expectedHostname) {
      const error = Object.assign(new Error("Pinned hostname mismatch"), { code: "ENOTFOUND" });
      queueMicrotask(() => callback(error, "", 0));
      return;
    }

    const requestedFamily = typeof options === "number" ? options : options.family;
    const candidates = requestedFamily === 4 || requestedFamily === 6
      ? answers.filter(({ family }) => family === requestedFamily)
      : answers;
    if (candidates.length === 0) {
      const error = Object.assign(new Error("Pinned address family unavailable"), { code: "ENOTFOUND" });
      queueMicrotask(() => callback(error, "", 0));
      return;
    }

    if (typeof options !== "number" && options.all === true) {
      const records = candidates.map(({ address, family }) => ({ address, family }));
      queueMicrotask(() => callback(null, records));
      return;
    }
    const selected = candidates[0];
    if (selected === undefined) return;
    queueMicrotask(() => callback(null, selected.address, selected.family));
  };
}

function copyHeaders(
  headers: Record<string, string | string[] | undefined>,
): Readonly<Record<string, string | readonly string[] | undefined>> {
  const copy: Record<string, string | readonly string[] | undefined> = Object.create(null) as Record<
    string,
    string | readonly string[] | undefined
  >;
  for (const [name, value] of Object.entries(headers)) {
    copy[name] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return Object.freeze(copy);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return value?.length === 1 ? value[0] : undefined;
}

function destroyBody(body: NodeJS.ReadableStream & { destroy(error?: Error): unknown }): void {
  body.on("error", () => undefined);
  body.destroy();
}

async function readBody(
  body: NodeJS.ReadableStream & { destroy(error?: Error): unknown },
  maximum: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const rawChunk of body) {
    const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : new Uint8Array(rawChunk);
    size += chunk.byteLength;
    if (size > maximum) {
      destroyBody(body);
      throw policyError("SSS_BODY_TOO_LARGE", "Response body exceeds the configured limit");
    }
    chunks.push(chunk);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function stripCrossOriginSecrets(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) {
    if (!CROSS_ORIGIN_SECRET_HEADER.test(name)) result[name] = value;
  }
  return result;
}

function transitionedRequest(
  status: number,
  method: "GET" | "HEAD" | "POST",
  body: string | Uint8Array | undefined,
  headers: Record<string, string>,
): { method: "GET" | "HEAD" | "POST"; body: string | Uint8Array | undefined; headers: Record<string, string> } {
  if (status === 303 && method !== "HEAD" || (status === 301 || status === 302) && method === "POST") {
    const nextHeaders = { ...headers };
    delete nextHeaders["content-type"];
    return { method: "GET", body: undefined, headers: nextHeaders };
  }
  return { method, body, headers };
}

function isSizeError(error: unknown): boolean {
  return error instanceof errors.ResponseExceededMaxSizeError ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "UND_ERR_RES_EXCEEDED_MAX_SIZE");
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function safeRequest(
  value: string | URL,
  options: SafeRequestOptions = {},
): Promise<SafeResponse> {
  let method: "GET" | "HEAD" | "POST" = options.method ?? "GET";
  const runtimeOptions = options as SafeRequestOptions & {
    readonly allowPrivate?: unknown;
    readonly body?: unknown;
    readonly trustedSink?: unknown;
  };
  if (method === "POST") {
    if (runtimeOptions.trustedSink !== true || typeof runtimeOptions.allowPrivate !== "boolean") {
      throw policyError(
        "SSS_OPTIONS_INVALID",
        "POST requires trustedSink=true and an explicit allowPrivate boolean",
      );
    }
  } else if (method !== "GET" && method !== "HEAD") {
    throw policyError("SSS_OPTIONS_INVALID", "Request method is forbidden");
  } else if (runtimeOptions.allowPrivate === true || runtimeOptions.body !== undefined) {
    throw policyError("SSS_OPTIONS_INVALID", "Read requests cannot opt into private access or carry a body");
  }

  const allowPrivate = method === "POST" && runtimeOptions.allowPrivate === true;
  const timeoutMs = integerOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs");
  const maxBodyBytes = integerOption(
    options.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
    MAX_BODY_BYTES,
    "maxBodyBytes",
  );
  const maxRedirects = integerOption(
    options.maxRedirects,
    DEFAULT_MAX_REDIRECTS,
    MAX_REDIRECTS,
    "maxRedirects",
    true,
  );
  const redirectOrigins = allowedRedirectOrigins(options.redirectAllowlist);
  const signal = AbortSignal.timeout(timeoutMs);
  let current = parseUrl(value);
  let headers = requestHeaders(options.headers);
  let body = method === "POST" ? options.body : undefined;
  let redirectCount = 0;

  while (true) {
    if (signal.aborted) {
      throw policyError("SSS_TIMEOUT", "Request exceeded the configured timeout");
    }
    let validated: ValidatedTarget;
    try {
      validated = await abortable(validateTarget(current, {
        allowPrivate,
        ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      }), signal);
    } catch (error) {
      if (signal.aborted) {
        throw policyError("SSS_TIMEOUT", "Request exceeded the configured timeout");
      }
      throw error;
    }
    const expectedHostname = bareHostname(validated.url.hostname);
    const agent = new Agent({
      autoSelectFamily: true,
      connect: {
        lookup: pinnedLookup(expectedHostname, validated.addresses),
        timeout: Math.min(timeoutMs, 10_000),
      },
      maxResponseSize: maxBodyBytes,
      pipelining: 1,
    });

    try {
      const response = await undiciRequest(validated.url, {
        ...(body === undefined ? {} : { body }),
        bodyTimeout: timeoutMs,
        dispatcher: agent,
        headers,
        headersTimeout: timeoutMs,
        method,
        signal,
      });

      const location = firstHeader(response.headers.location);
      if (REDIRECT_STATUSES.has(response.statusCode) && location !== undefined) {
        destroyBody(response.body);
        if (redirectCount >= maxRedirects) {
          throw policyError("SSS_REDIRECT_REJECTED", "Redirect limit exceeded");
        }
        let next: URL;
        try {
          next = parseUrl(new URL(location, validated.url));
        } catch (error) {
          if (error instanceof NetworkSecurityError) throw error;
          throw policyError("SSS_REDIRECT_REJECTED", "Redirect target is invalid");
        }
        const crossOrigin = next.origin !== validated.url.origin;
        if (crossOrigin && !redirectOrigins.has(next.origin)) {
          throw policyError("SSS_REDIRECT_REJECTED", "Cross-origin redirect is not allowlisted");
        }
        const transitioned = transitionedRequest(response.statusCode, method, body, headers);
        method = transitioned.method;
        body = transitioned.body;
        headers = crossOrigin ? stripCrossOriginSecrets(transitioned.headers) : transitioned.headers;
        current = next;
        redirectCount += 1;
        continue;
      }

      const encoding = firstHeader(response.headers["content-encoding"]);
      if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
        destroyBody(response.body);
        throw policyError("SSS_REQUEST_FAILED", "Server ignored the identity encoding requirement");
      }
      const declaredLength = firstHeader(response.headers["content-length"]);
      if (declaredLength !== undefined && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBodyBytes) {
        destroyBody(response.body);
        throw policyError("SSS_BODY_TOO_LARGE", "Response body exceeds the configured limit");
      }

      const responseBody = await readBody(response.body, maxBodyBytes);
      return Object.freeze({
        body: responseBody,
        headers: copyHeaders(response.headers),
        status: response.statusCode,
        statusText: stripControlText(response.statusText),
        url: validated.url.href,
      });
    } catch (error) {
      if (error instanceof NetworkSecurityError) throw error;
      if (signal.aborted) {
        throw policyError("SSS_TIMEOUT", "Request exceeded the configured timeout");
      }
      if (isSizeError(error)) {
        throw policyError("SSS_BODY_TOO_LARGE", "Response body exceeds the configured limit");
      }
      throw policyError(
        "SSS_REQUEST_FAILED",
        `Request failed for ${redactUrl(current)}: ${safeErrorMessage(error)}`,
      );
    } finally {
      await agent.destroy().catch(() => undefined);
    }
  }
}

/** Fetch-shaped GET/HEAD adapter for source collectors; private-network access stays disabled. */
export async function safeFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  let request: Request;
  try {
    request = new Request(input, init);
  } catch {
    throw policyError("SSS_OPTIONS_INVALID", "Invalid fetch request");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw policyError("SSS_OPTIONS_INVALID", "Source fetch method must be GET or HEAD");
  }
  const headers = Object.fromEntries(request.headers.entries());
  const acquired = await safeRequest(request.url, {
    headers,
    method: request.method,
  });
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(acquired.headers)) {
    if (typeof value === "string") responseHeaders.set(name, value);
    else for (const item of value ?? []) responseHeaders.append(name, item);
  }
  const responseBody = new Uint8Array(acquired.body.byteLength);
  responseBody.set(acquired.body);
  const statusForbidsBody = acquired.status === 204 || acquired.status === 205 || acquired.status === 304;
  const response = new Response(request.method === "HEAD" || statusForbidsBody ? null : responseBody, {
    headers: responseHeaders,
    status: acquired.status,
    statusText: acquired.statusText,
  });
  Object.defineProperty(response, "url", { configurable: false, enumerable: true, value: acquired.url });
  return response;
}
