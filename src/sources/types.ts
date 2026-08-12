import type {
  BrowserOsSource,
  FeedSource,
  HeadersConfig,
  HtmlSource,
  JsonSource,
  OpenAlexSource,
  Source,
} from "../config/schema.ts";
import type { Collection, JsonObject, JsonValue, ScanItem } from "../core/types.ts";

export type Item = ScanItem;
export type Collected = Collection;
export type { BrowserOsSource, FeedSource, HtmlSource, JsonObject, JsonSource, JsonValue, OpenAlexSource, Source };

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type BrowserOsMcpClient = {
  listTools(): Promise<unknown>;
  callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
};

export const MAX_SOURCE_ITEMS = 10_000;

export function assertSourceItemLimit(length: number): void {
  if (length > MAX_SOURCE_ITEMS) throw new Error(`source exceeded the hard limit of ${MAX_SOURCE_ITEMS} items`);
}

export type SourceDependencies = {
  /** Must enforce the caller's network policy, including redirects and DNS rebinding. */
  fetch: FetchLike;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
  createBrowserOsClient?: (fetch: FetchLike) => Promise<BrowserOsMcpClient>;
};

export function resolvedHeaders(
  headers: HeadersConfig | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") {
      resolved[name] = value;
      continue;
    }
    const secret = env[value.env];
    if (secret === undefined || secret === "") throw new Error(`missing environment secret: ${value.env}`);
    resolved[name] = secret;
  }
  return resolved;
}

export function finish(items: Item[], dependencies: SourceDependencies): Collected {
  const fetchedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  if (fetchedAt === "Invalid Date") throw new Error("source clock returned an invalid date");
  return { items, fetchedAt };
}
