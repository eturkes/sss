import type { JsonObject, ScanItem } from "../core/types.ts";
import { collectFeed } from "./feed.ts";
import { finish, type SourceDependencies } from "./types.ts";

export type RedditDiscussionSource = { type: "reddit_discussions"; subreddit: string; keywords: string[]; lookbackDays: number; limit: number; maxThreads: number; context?: "feed" | "thread" };
type Pacer = (request: () => Promise<Response>) => Promise<Response>;

export function createRedditPacer(clock = Date.now, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Pacer {
  let queue: Promise<unknown> = Promise.resolve();
  let next = 0;
  return request => {
    const pending = queue.then(async () => {
      if (next > clock()) await wait(next - clock());
      // Public feeds returned 429 at 20 s spacing, then succeeded after 61 s.
      next = clock() + 61_000;
      const response = await request();
      if (response.status === 429 || response.status === 503) {
        const header = response.headers.get("retry-after");
        const until = header && /^\d+$/.test(header) ? clock() + Number(header) * 1000 : header ? Date.parse(header) : NaN;
        next = Math.max(next, Number.isFinite(until) ? until + 1000 : clock() + 61_000);
      }
      return response;
    });
    queue = pending.catch(() => {});
    return pending;
  };
}

const paceReddit = createRedditPacer();
const COVERAGE = "Publisher comment-feed window and publisher thread-feed window only; either can omit comments. This is not a complete Reddit conversation or a global Reddit search.";
const FEED_COVERAGE = "Subreddit comment-feed window only; original post not fetched; replies may be omitted. This is not a complete Reddit conversation or a global Reddit search.";

function identity(item: ScanItem, subreddit: string): { thread: string; comment?: string } {
  if (!item.url || !item.publishedAt || !item.title || typeof item.data.summary !== "string" || !item.data.summary.trim()) throw new Error("Reddit feed observation lacks required content or metadata");
  const url = new URL(item.url);
  const match = /^\/r\/([A-Za-z0-9_]+)\/comments\/([a-z0-9]+)\/[^/]+\/(?:([a-z0-9]+)\/)?$/.exec(url.pathname);
  if (url.origin !== "https://www.reddit.com" || !match || match[1]!.toLowerCase() !== subreddit.toLowerCase()) throw new Error("Reddit feed observation has a foreign thread identity");
  const expected = match[3] ? `id:t1_${match[3]}` : `id:t3_${match[2]}`;
  if (item.id !== expected) throw new Error("Reddit feed provider identity disagrees with its permalink");
  return { thread: match[2]!, ...(match[3] ? { comment: match[3] } : {}) };
}

function body(item: ScanItem): string {
  return ["summary", "content", "encoded", "description"].flatMap(key => typeof item.data[key] === "string" ? [String(item.data[key])] : []).join("\n\n");
}

export async function collectRedditDiscussions(source: RedditDiscussionSource, dependencies: SourceDependencies, pace: Pacer = paceReddit) {
  const upper = (dependencies.now ?? (() => new Date()))().getTime();
  const lower = upper - source.lookbackDays * 86_400_000;
  const paced = { ...dependencies, fetch: (input: string | URL | Request, init?: RequestInit) => pace(() => dependencies.fetch(input, init)) };
  const discovery = await collectFeed({ type: "feed", identity: "provider", url: `https://www.reddit.com/r/${encodeURIComponent(source.subreddit)}/comments/.rss?limit=${source.limit}` }, paced);
  const groups = new Map<string, Map<string, ScanItem>>();
  const feedThreads = new Map<string, ScanItem[]>();
  const keywords = source.keywords.map(value => value.normalize("NFKC").toLowerCase());
  for (const item of discovery.items) {
    const { thread, comment } = identity(item, source.subreddit);
    if (!comment) throw new Error("Reddit comment discovery returned a post rather than a comment");
    if (!feedThreads.has(thread)) feedThreads.set(thread, []);
    feedThreads.get(thread)!.push(item);
    const published = Date.parse(item.publishedAt!);
    if (published < lower || published > upper) continue;
    const text = `${item.title}\n${body(item)}`.normalize("NFKC").toLowerCase();
    if (keywords.length && !keywords.some(keyword => text.includes(keyword))) continue;
    if (!groups.has(thread)) groups.set(thread, new Map());
    groups.get(thread)!.set(item.id, item);
  }
  if (groups.size > source.maxThreads) throw new Error("Reddit discovered thread count exceeds its limit");
  const items: ScanItem[] = [];
  let emittedBytes = 2;
  for (const [thread, triggers] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const snapshot = source.context === "feed" ? { items: feedThreads.get(thread)! }
      : await collectFeed({ type: "feed", identity: "provider", url: `https://www.reddit.com/comments/${thread}/.rss?limit=500` }, paced);
    const observed = new Map<string, ScanItem>();
    for (const item of snapshot.items) {
      if (identity(item, source.subreddit).thread !== thread) throw new Error("Reddit thread feed returned a foreign thread");
      observed.set(item.id, item);
    }
    for (const [id, trigger] of triggers) {
      const actual = observed.get(id);
      if (!actual) throw new Error("Reddit thread context omits a triggering discovery comment");
      if (body(actual) !== body(trigger) || actual.url !== trigger.url || actual.publishedAt !== trigger.publishedAt) throw new Error("Reddit comment changed between discovery and thread context");
    }
    const ordered = [...observed.values()].sort((a, b) => a.id.localeCompare(b.id));
    const root = observed.get(`id:t3_${thread}`);
    const title = root?.title ?? [...triggers.values()].sort((a, b) => a.id.localeCompare(b.id))[0]!.title!;
    const url = `https://www.reddit.com/comments/${thread}/`;
    const comments: JsonObject[] = ordered.filter(item => item.id !== root?.id).map(item => ({ id: item.id, url: item.url!, body: body(item),
      author: Array.isArray(item.data.authors) ? item.data.authors.join(", ") : item.title!.split(" on ")[0]!, publishedAt: item.publishedAt! }));
    const item: ScanItem = { id: `reddit:${thread}`, url, title,
      ...(root?.publishedAt ? { publishedAt: root.publishedAt } : {}),
      data: { title, url, subreddit: source.subreddit, coverage: source.context === "feed" ? FEED_COVERAGE : COVERAGE, comments, body: root ? body(root) : "", ...(!root ? { rootUnavailable: true } : {}) } };
    emittedBytes += Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
    if (emittedBytes > 16 * 1024 * 1024) throw new Error("Reddit observation snapshot exceeds the 16 MiB byte limit");
    items.push(item);
  }
  return finish(items, dependencies);
}
