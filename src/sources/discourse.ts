import { fetchText } from "./http.ts";
import { finish, type FetchLike, type Item, type SourceDependencies } from "./types.ts";

export type DiscourseSource = {
  type: "discourse";
  url: string;
  queries: string[];
  lookbackDays?: number;
  maxPages?: number;
  maxTopics?: number;
  maxPosts?: number;
  unavailablePosts?: "reject" | "mark";
};

type RecordValue = Record<string, unknown>;
type SearchPage = { hits: { id: number; topicId: number }[]; more: boolean };
type Availability = { unavailable: true; hidden: boolean; userDeleted: boolean; deletedAt: string | null };
type Post = { id: number; number: number; author: string; created: string; body: string; parent: number | null; availability?: Availability };
const DAY = 86_400_000;
const MAX_BYTES = 16 * 1024 * 1024;
export type DiscourseTiming = { now: () => number; wait: (ms: number) => Promise<void> };
const defaultTiming: DiscourseTiming = { now: Date.now, wait: ms => new Promise(resolve => setTimeout(resolve, ms)) };
type RequestPace = { nextRequest: number; nextSearch: number; queue: Promise<void> };
const pacing = new WeakMap<DiscourseTiming, Map<string, RequestPace>>();
const fail = (message: string): never => { throw new Error(`Discourse ${message}`); };
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : fail("response lacks an object");
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail("response lacks an array");
const integer = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail("response has an invalid ID/count");
const string = (value: unknown): string => typeof value === "string" && value.trim() ? value : fail("response lacks nonempty text");
const date = (value: unknown): string => { const text = string(value); if (!Number.isFinite(Date.parse(text))) fail("response has an invalid date"); return text; };

export async function collectDiscourse(source: DiscourseSource, dependencies: SourceDependencies, timing = defaultTiming) {
  const origin = new URL(source.url);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) fail("source URL must be an HTTPS origin");
  const fetch = dependencies.fetch;
  dependencies = { ...dependencies, fetch: (input, init) => pacedFetch(origin.origin, fetch, input, init, timing) };
  const now = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) fail("source clock returned an invalid date");
  // Discourse's documented date filters have day precision. Freeze both calendar bounds for traversal.
  const after = new Date(now.getTime() - (source.lookbackDays ?? 30) * DAY).toISOString().slice(0, 10);
  const before = new Date(now.getTime() + DAY).toISOString().slice(0, 10);
  const topics = new Map<number, Set<number>>();
  for (const query of source.queries) {
    if (/\b(?:after|before|order|in):/i.test(query)) fail("queries must leave scope/date/order filters to the adapter");
    const term = `${query} after:${after} before:${before} order:latest`;
    const seen = new Set<number>();
    let first: SearchPage | undefined;
    for (let page = 1; ; page++) {
      if (page > (source.maxPages ?? 10)) fail("search exceeded its page limit");
      const url = new URL("/search.json", origin);
      url.searchParams.set("q", term);
      url.searchParams.set("page", String(page));
      const result = parseSearch(await json(url, dependencies), after, before);
      first ??= result;
      for (const hit of result.hits) {
        if (seen.has(hit.id)) fail("search returned duplicate/repeated post identities");
        seen.add(hit.id);
        const matches = topics.get(hit.topicId) ?? new Set<number>();
        matches.add(hit.id);
        topics.set(hit.topicId, matches);
      }
      if (topics.size > (source.maxTopics ?? 100)) fail("search exceeded its topic limit");
      if (!result.more) {
        if (page > 1) {
          url.searchParams.set("page", "1");
          const repeat = parseSearch(await json(url, dependencies), after, before);
          if (JSON.stringify(repeat) !== JSON.stringify(first)) fail("search changed during pagination");
        }
        break;
      }
      if (!result.hits.length) fail("search returned an empty nonfinal page");
    }
  }
  const items: Item[] = [];
  let bytes = 0;
  for (const [topicId, matches] of [...topics].sort((a, b) => a[0] - b[0])) {
    const item = await collectTopic(origin, topicId, matches, source.maxPosts ?? 2000, MAX_BYTES - bytes, source.unavailablePosts ?? "reject", dependencies);
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > MAX_BYTES) fail("discussion collection exceeded its byte limit");
    items.push(item);
  }
  return finish(items, dependencies);
}

async function pacedFetch(origin: string, fetch: FetchLike, input: Parameters<FetchLike>[0], init: RequestInit | undefined, timing: DiscourseTiming): Promise<Response> {
  const origins = pacing.get(timing) ?? new Map<string, RequestPace>();
  pacing.set(timing, origins);
  const state = origins.get(origin) ?? { nextRequest: 0, nextSearch: 0, queue: Promise.resolve() };
  origins.set(origin, state);
  const task = state.queue.then(async () => {
    const isSearch = new URL(String(input)).pathname === "/search.json";
    const delay = Math.max(state.nextRequest, isSearch ? state.nextSearch : 0) - timing.now();
    if (delay > 60_000) fail("provider Retry-After still blocks this acquisition");
    if (delay > 0) await timing.wait(delay);
    state.nextRequest = timing.now() + 2_000;
    // Default anonymous search limit = 15/minute; a margin avoids boundary bursts.
    if (isSearch) state.nextSearch = timing.now() + 4_100;
    const response = await fetch(input, init);
    if (response.status === 429 || response.status === 503) {
      const header = response.headers.get("retry-after");
      const seconds = header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
      const until = seconds !== undefined ? timing.now() + seconds * 1000 : header ? Date.parse(header) : timing.now() + 60_000;
      if (Number.isFinite(until)) state.nextRequest = Math.max(state.nextRequest, until);
    }
    return response;
  });
  state.queue = task.then(() => undefined, () => undefined);
  return task;
}

async function json(url: URL, dependencies: SourceDependencies): Promise<unknown> {
  const result = await fetchText(url.href, dependencies, undefined, "application/json");
  if (result.url !== url.href) fail("request redirected away from its fixed API URL");
  if (Buffer.byteLength(result.text, "utf8") > 4 * 1024 * 1024) fail("response exceeded its byte limit");
  try { return JSON.parse(result.text) as unknown; } catch { return fail("source returned invalid JSON"); }
}

function parseSearch(value: unknown, after: string, before: string): SearchPage {
  const root = record(value);
  const group = record(root["grouped_search_result"]);
  if (group["error"] !== null || ![null, false, true].includes(group["more_full_page_results"] as null | boolean)) fail("search lacks explicit completion or reports an error");
  const hits = array(root["posts"]).map(value => {
    const post = record(value);
    const created = Date.parse(date(post["created_at"]));
    if (created < Date.parse(after) || created >= Date.parse(before)) fail("search returned a post outside its date bounds");
    return { id: integer(post["id"]), topicId: integer(post["topic_id"]) };
  });
  const ids = array(group["post_ids"]).map(integer);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify(hits.map(hit => hit.id))) fail("search result identities are incomplete or duplicate");
  return { hits, more: group["more_full_page_results"] === true };
}

function manifest(value: unknown, topicId: number, maxPosts: number) {
  const root = record(value);
  if (integer(root["id"]) !== topicId) fail("topic response has a foreign identity");
  const stream = record(root["post_stream"]);
  const ids = array(stream["stream"]).map(integer);
  if (ids.length > maxPosts) fail("topic exceeded its post limit");
  if (new Set(ids).size !== ids.length || integer(root["posts_count"]) !== ids.length) fail("topic post manifest is incomplete or duplicate");
  return { ids, title: string(root["title"]), created: date(root["created_at"]), posts: array(stream["posts"]) };
}

async function collectTopic(origin: URL, topicId: number, matches: Set<number>, maxPosts: number, maxBytes: number, unavailablePosts: "reject" | "mark", dependencies: SourceDependencies): Promise<Item> {
  const topicUrl = new URL(`/t/${topicId}`, origin).href;
  const apiUrl = new URL(`/t/${topicId}.json`, origin);
  const initial = manifest(await json(apiUrl, dependencies), topicId, maxPosts);
  const wanted = new Set(initial.ids);
  for (const id of matches) if (!wanted.has(id)) fail("matching search post is absent from the topic");
  const posts = new Map<number, Post>();
  let bytes = 0;
  function add(values: unknown[], expected: Set<number>) {
    for (const value of values) {
      const raw = record(value);
      const id = integer(raw["id"]);
      if (integer(raw["topic_id"]) !== topicId || !expected.has(id) || posts.has(id)) fail("topic has a duplicate or foreign post");
      for (const flag of ["hidden", "user_deleted"]) if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") fail("post availability flag is malformed");
      const hidden = raw["hidden"] === true;
      const userDeleted = raw["user_deleted"] === true;
      const deletedAt = raw["deleted_at"] == null ? null : date(raw["deleted_at"]);
      const unavailable = hidden || userDeleted || deletedAt !== null;
      if (unavailable && unavailablePosts === "reject") fail("topic has an inaccessible post");
      const body = unavailable && unavailablePosts === "mark" ? raw["cooked"] === undefined ? "" : typeof raw["cooked"] === "string" ? raw["cooked"] : fail("unavailable post body is malformed") : string(raw["cooked"]);
      const parent = raw["reply_to_post_number"] == null ? null : integer(raw["reply_to_post_number"]);
      const post: Post = { id, number: integer(raw["post_number"]), author: string(raw["username"]), created: date(raw["created_at"]), body, parent,
        ...(unavailable ? { availability: { unavailable: true, hidden, userDeleted, deletedAt } } : {}) };
      bytes += Buffer.byteLength(JSON.stringify(post));
      if (bytes > maxBytes) fail("discussion collection exceeded its byte limit");
      posts.set(id, post);
    }
  }
  add(initial.posts, wanted);
  const missing = initial.ids.filter(id => !posts.has(id));
  for (let offset = 0; offset < missing.length; offset += 20) {
    const batch = missing.slice(offset, offset + 20);
    const url = new URL(`/t/${topicId}/posts.json`, origin);
    for (const id of batch) url.searchParams.append("post_ids[]", String(id));
    const result = record(await json(url, dependencies));
    add(array(record(result["post_stream"])["posts"]), new Set(batch));
    for (const id of batch) if (!posts.has(id)) fail("topic chunk is missing a requested post");
  }
  const ordered = initial.ids.map(id => posts.get(id)!);
  if (posts.size !== wanted.size || ordered[0]?.number !== 1 || ordered.some((post, i) => i > 0 && post.number <= ordered[i - 1]!.number)) fail("topic post numbers are missing, duplicate, or out of order");
  const final = manifest(await json(apiUrl, dependencies), topicId, maxPosts);
  if (JSON.stringify([final.ids, final.title, final.created]) !== JSON.stringify([initial.ids, initial.title, initial.created])) fail("topic changed during acquisition");
  const root = ordered[0]!;
  const comments = ordered.slice(1).map(post => ({ id: post.id, postNumber: post.number, parentNumber: post.parent, author: post.author, publishedAt: post.created, body: post.body, url: `${topicUrl}/${post.number}`, ...post.availability }));
  const unavailableCount = ordered.filter(post => post.availability).length;
  return { id: `url:${topicUrl}`, url: topicUrl, title: initial.title, publishedAt: initial.created, data: { title: initial.title, url: topicUrl, body: root.body, author: root.author, comments, postCount: ordered.length,
    ...(root.availability ? { rootUnavailable: true, hidden: root.availability.hidden, userDeleted: root.availability.userDeleted, deletedAt: root.availability.deletedAt } : {}),
    ...(unavailableCount ? { unavailablePostCount: unavailableCount, coverage: "All publisher-listed post IDs were retrieved. Explicitly hidden or deleted posts are marked unavailable; their returned body is preserved when provided. Missing text is unavailable context, not evidence." } : {}),
  } };
}
