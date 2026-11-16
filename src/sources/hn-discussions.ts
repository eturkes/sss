import type { JsonObject } from "../core/types.ts";
import { fetchJson } from "./http.ts";
import { record } from "./normalize.ts";
import { finish, MAX_SOURCE_ITEMS, type Item, type SourceDependencies } from "./types.ts";

export type HnDiscussionsSource = {
  type: "hn_discussions";
  queries: string[];
  lookbackDays?: number;
  perPage?: number;
  maxPages?: number;
  maxThreads?: number;
  maxComments?: number;
};

const SEARCH = "https://hn.algolia.com/api/v1/search_by_date";
const ITEMS = "https://hacker-news.firebaseio.com/v0/item/";
const permalink = (id: number) => `https://news.ycombinator.com/item?id=${id}`;
const MAX_BYTES = 16 * 1024 * 1024;
type Node = {
  id: number; parent?: number; type?: string; kids: number[]; descendants?: number;
  title?: string; text?: string; by?: string; time?: number; url?: string; deleted: boolean; dead: boolean;
};

export async function collectHnDiscussions(source: HnDiscussionsSource, dependencies: SourceDependencies) {
  const perPage = limit(source.perPage, 100, 100, "perPage");
  const maxPages = limit(source.maxPages, 20, 100, "maxPages");
  const maxThreads = limit(source.maxThreads, 100, 100, "maxThreads");
  const maxComments = limit(source.maxComments, 2_000, MAX_SOURCE_ITEMS, "maxComments");
  const lookbackDays = limit(source.lookbackDays, 7, 30, "lookbackDays");
  if (!Array.isArray(source.queries) || source.queries.length < 1 || source.queries.length > 50 || source.queries.some(query => typeof query !== "string" || !query.trim() || query.length > 200)) throw new Error("HN queries must contain bounded nonempty search strings");
  const upper = Math.floor((dependencies.now ?? (() => new Date()))().getTime() / 1_000);
  const lower = upper - lookbackDays * 86_400;
  if (!Number.isSafeInteger(upper) || lower < 0) throw new Error("HN source clock is invalid");
  const candidates = new Map<number, Set<number>>();
  for (const query of source.queries) {
    const url = new URL(SEARCH);
    url.search = new URLSearchParams({ query, tags: "(story,comment,poll)", hitsPerPage: String(perPage), typoTolerance: "false", numericFilters: `created_at_i>=${lower},created_at_i<${upper}` }).toString();
    const seen = new Set<number>();
    let total: number | undefined;
    for (let index = 0; index < maxPages; index++) {
      url.searchParams.set("page", String(index));
      const result = record(await fetchJson(url.href, dependencies));
      const count = result?.["nbHits"];
      const exhaustive = result?.["exhaustiveNbHits"] ?? record(result?.["exhaustive"])?.["nbHits"];
      if (!result || !natural(count) || exhaustive !== true || !Array.isArray(result["hits"])) throw new Error("HN search lacks an exhaustive result count");
      if (total !== undefined && count !== total) throw new Error("HN search count changed during pagination");
      total = count;
      if (count > Math.min(MAX_SOURCE_ITEMS, perPage * maxPages)) throw new Error("HN search exceeds its complete acquisition limit; narrow the query");
      if (result["page"] !== index || result["hitsPerPage"] !== perPage || result["nbPages"] !== Math.ceil(count / perPage)) throw new Error("HN search pagination is incomplete or truncated");
      if (result["hits"].length !== Math.min(perPage, count - seen.size)) throw new Error("HN search page is incomplete");
      for (const value of result["hits"]) {
        const hit = record(value);
        const rawId = hit?.["objectID"];
        const id = typeof rawId === "string" && /^[1-9]\d*$/.test(rawId) ? Number(rawId) : undefined;
        const tags = hit?.["_tags"], created = hit?.["created_at_i"];
        if (!positive(id) || !Array.isArray(tags) || !natural(created) || created < lower || created >= upper) throw new Error("HN search hit has an invalid identity or frozen-window timestamp");
        const isComment = tags.includes("comment");
        if (Number(isComment) + Number(tags.includes("story")) + Number(tags.includes("poll")) !== 1) throw new Error("HN search hit has an invalid type");
        const rootId = isComment ? hit?.["story_id"] : id;
        if (!positive(rootId)) throw new Error("HN comment search hit lacks a story identity");
        if (seen.has(id)) throw new Error("HN search pagination repeated an identity");
        seen.add(id);
        const hits = candidates.get(rootId) ?? new Set<number>();
        hits.add(id); candidates.set(rootId, hits);
        if (candidates.size > maxThreads) throw new Error("HN discovery exceeded its thread limit");
      }
      if (seen.size === count) break;
      if (index + 1 === maxPages) throw new Error("HN discovery reached its page limit");
    }
  }
  const items: Item[] = [];
  let totalComments = 0, bytes = 0;
  let acquiredBytes = 0;
  async function acquireNode(id: number): Promise<Node> {
    const node = await readNode(id, dependencies);
    acquiredBytes += Buffer.byteLength(JSON.stringify(node));
    if (acquiredBytes > MAX_BYTES) throw new Error("HN discussion acquisition exceeded its byte limit");
    return node;
  }
  for (const [id, matches] of [...candidates].sort(([a], [b]) => a - b)) {
    const root = await acquireNode(id);
    requireRoot(root);
    if (root.descendants! > maxComments) throw new Error("HN thread exceeds its comment limit");
    const nodes = new Map<number, Node>([[id, root]]);
    const queue = root.kids.map(child => ({ id: child, parent: id }));
    const scheduled = new Set([id]);
    let visible = 0;
    while (queue.length > 0) {
      const batch = queue.splice(0, 16);
      for (const child of batch) {
        if (scheduled.has(child.id)) throw new Error("HN thread repeats a comment or contains a cycle");
        scheduled.add(child.id);
      }
      totalComments += batch.length;
      if (scheduled.size - 1 > maxComments || totalComments > MAX_SOURCE_ITEMS) throw new Error("HN acquisition exceeded its comment limit");
      const acquired = await Promise.all(batch.map(async child => ({ ...child, node: await acquireNode(child.id) })));
      for (const { node, parent } of acquired) {
        if (node.parent !== parent || (node.type !== "comment" && !node.deleted)) throw new Error("HN comment has an invalid parent or type");
        if (!node.deleted && !node.dead) {
          if (!node.by || node.time === undefined || typeof node.text !== "string" || !node.text.trim()) throw new Error("HN visible comment lacks its authored content");
          visible++;
        }
        nodes.set(node.id, node);
        queue.push(...node.kids.map(child => ({ id: child, parent: node.id })));
      }
    }
    if (visible !== root.descendants) throw new Error("HN thread comment count is incomplete or changed during acquisition");
    for (const match of matches) if (!nodes.has(match)) throw new Error("HN thread is missing a matched discovery comment");
    const refreshed = await acquireNode(id);
    requireRoot(refreshed);
    // Rank and votes are not evidence revisions. Compare structure/content while preserving authored strings.
    if (JSON.stringify({ ...root, kids: [...root.kids].sort((a, b) => a - b) }) !== JSON.stringify({ ...refreshed, kids: [...refreshed.kids].sort((a, b) => a - b) })) throw new Error("HN thread changed during acquisition");
    const comments = [...nodes.values()].filter(node => node.id !== id).sort((a, b) => a.id - b.id).map(commentData);
    const url = permalink(id), publishedAt = new Date(root.time! * 1_000).toISOString();
    const data: JsonObject = { platform: "Hacker News", threadId: id, title: root.title!, url, author: root.by!, publishedAt, body: root.text ?? "", comments, commentCount: visible };
    if (root.url !== undefined) data["externalUrl"] = root.url;
    const item = { id: `hn:${id}`, title: root.title!, url, publishedAt, data };
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > MAX_BYTES) throw new Error("HN discussion acquisition exceeded its byte limit");
    items.push(item);
  }
  return finish(items, dependencies);
}

async function readNode(id: number, dependencies: SourceDependencies): Promise<Node> {
  const raw = record(await fetchJson(`${ITEMS}${id}.json`, dependencies));
  if (!raw || raw["id"] !== id) throw new Error("HN item is missing or has an inconsistent identity");
  const kids = raw["kids"] ?? [];
  if (!Array.isArray(kids) || kids.some(child => !positive(child)) || new Set(kids).size !== kids.length) throw new Error("HN item has invalid child identities");
  if (kids.length > MAX_SOURCE_ITEMS) throw new Error("HN item exceeds its child limit");
  const node: Node = { id, kids: kids as number[], deleted: false, dead: false };
  for (const field of ["deleted", "dead"] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== "boolean") throw new Error(`HN ${field} flag is malformed`);
    node[field] = raw[field] === true;
  }
  for (const field of ["type", "title", "text", "by", "url"] as const) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "string") throw new Error(`HN ${field} field is malformed`);
    node[field] = raw[field];
  }
  for (const field of ["time", "parent", "descendants"] as const) {
    if (raw[field] === undefined) continue;
    if (!natural(raw[field]) || (field === "parent" && raw[field] === 0)) throw new Error(`HN ${field} field is malformed`);
    node[field] = raw[field];
  }
  if (node.time !== undefined && !Number.isFinite(new Date(node.time * 1_000).getTime())) throw new Error("HN timestamp is invalid");
  return node;
}

function requireRoot(node: Node): void {
  if (!["story", "poll"].includes(node.type ?? "") || node.deleted || node.dead || !node.title?.trim() || !node.by || node.time === undefined || node.descendants === undefined) throw new Error("HN story lacks complete live thread metadata");
}

function commentData(node: Node): JsonObject {
  const data: JsonObject = { id: node.id, parent: node.parent!, url: permalink(node.id), deleted: node.deleted, dead: node.dead };
  if (node.by !== undefined) data["author"] = node.by;
  if (node.time !== undefined) data["publishedAt"] = new Date(node.time * 1_000).toISOString();
  if (node.text !== undefined) data["text"] = node.text;
  return data;
}

function natural(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function positive(value: unknown): value is number { return natural(value) && value > 0; }
function limit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const selected = value ?? fallback;
  if (!positive(selected) || selected > maximum) throw new Error(`HN ${name} is outside its supported limit`);
  return selected;
}
