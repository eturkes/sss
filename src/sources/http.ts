import type { HeadersConfig } from "../config/schema.ts";
import type { SourceDependencies } from "./types.ts";
import { resolvedHeaders } from "./types.ts";

export async function fetchText(
  url: string,
  dependencies: SourceDependencies,
  headers: HeadersConfig | undefined,
  accept: string,
): Promise<{ text: string; url: string }> {
  const response = await dependencies.fetch(url, {
    method: "GET",
    headers: { Accept: accept, ...resolvedHeaders(headers, dependencies.env) },
  });
  if (!response.ok) throw new Error(`source request failed with HTTP ${response.status}`);
  return { text: await response.text(), url: response.url || url };
}

export async function fetchJson(
  url: string,
  dependencies: SourceDependencies,
  headers?: HeadersConfig,
): Promise<unknown> {
  const { text } = await fetchText(url, dependencies, headers, "application/json");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("source returned invalid JSON");
  }
}
