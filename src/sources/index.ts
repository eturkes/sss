import type { Source } from "../config/schema.ts";
import type { Collection } from "../core/types.ts";
import { collectBrowserOs } from "./browseros.ts";
import { collectFeed } from "./feed.ts";
import { collectHtml } from "./html.ts";
import { collectJson } from "./json.ts";
import { collectOpenAlex } from "./openalex.ts";
import type { SourceDependencies } from "./types.ts";

export * from "./browseros.ts";
export * from "./feed.ts";
export * from "./html.ts";
export * from "./json.ts";
export * from "./normalize.ts";
export * from "./openalex.ts";
export * from "./types.ts";

export async function collectSource(source: Source, dependencies: SourceDependencies): Promise<Collection> {
  switch (source.type) {
    case "feed": return collectFeed(source, dependencies);
    case "json": return collectJson(source, dependencies);
    case "html": return collectHtml(source, dependencies);
    case "openalex": return collectOpenAlex(source, dependencies);
    case "browseros": return collectBrowserOs(source, dependencies);
  }
}

export function createCollector(dependencies: SourceDependencies): (source: unknown) => Promise<Collection> {
  return async (source) => {
    if (!source || typeof source !== "object" || !("type" in source)) throw new Error("source has no type");
    return collectSource(source as Source, dependencies);
  };
}
