import type { Source } from "../config/schema.ts";
import type { CollectorContext } from "../core/engine.ts";
import type { Collection } from "../core/types.ts";
import type { SourceDependencies } from "./types.ts";

export async function collectSource(source: Source, dependencies: SourceDependencies, context?: CollectorContext): Promise<Collection> {
  switch (source.type) {
    case "feed": return (await import("./feed.ts")).collectFeed(source, dependencies);
    case "json": return (await import("./json.ts")).collectJson(source, dependencies);
    case "html": return (await import("./html.ts")).collectHtml(source, dependencies);
    case "openalex": return (await import("./openalex.ts")).collectOpenAlex(source, dependencies);
    case "browseros": return (await import("./browseros.ts")).collectBrowserOs(source, dependencies);
    case "x": return (await import("./x.ts")).collectX(source, dependencies, context);
    case "arxiv": return (await import("./arxiv.ts")).collectArxiv(source, dependencies);
    case "crossref": return (await import("./crossref.ts")).collectCrossref(source, dependencies);
    case "sel4_news": return (await import("./sel4.ts")).collectSel4News(source, dependencies);
    case "playwright": return (await import("./playwright.ts")).collectPlaywright(source, dependencies);
  }
}

export function createCollector(dependencies: SourceDependencies): (source: unknown, context?: CollectorContext) => Promise<Collection> {
  return async (source, context) => {
    if (!source || typeof source !== "object" || !("type" in source)) throw new Error("source has no type");
    return collectSource(source as Source, dependencies, context);
  };
}
