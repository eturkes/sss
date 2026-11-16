import type { CollectorContext } from "../core/engine.ts";
import type { ScanItem } from "../core/types.ts";
import { constants } from "node:fs";
import { lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { assertAllowedOrigin, checkedCall, createBrowserOsNeoClient, pageId, verifiedReadText, verifyTools } from "./browseros.ts";
import { record } from "./normalize.ts";
import { parseXPost } from "./x.ts";
import { finish, type BrowserOsMcpClient, type SourceDependencies } from "./types.ts";

export type XDiscussionSource = { type: "x_discussions"; query: string; maxPages: number };
const COVERAGE = "Indexed matching posts and replies; displayed ancestors only.";
const MAX_CELLS = 100;

function headerLength(text: string, handle: string): number {
  let offset = 0;
  while (text[offset] === "[") {
    const start = ++offset;
    let depth = 1;
    while (offset < text.length && depth) {
      if (text[offset] === "\\") { offset += 2; continue; }
      if (text[offset] === "[") depth++;
      if (text[offset] === "]") depth--;
      offset++;
    }
    const end = text.indexOf(")", offset);
    if (depth || text[offset] !== "(" || end < 0 || text.slice(offset + 1, end).toLowerCase() !== `https://x.com/${handle}`) break;
    const label = text.slice(start, offset - 1);
    offset = end + 1;
    if (label.toLowerCase() === `@${handle}`) return offset;
    while (/\s/.test(text[offset] ?? "")) offset++;
  }
  throw new Error("X discussion primary identity could not be verified");
}

export function primaryXIdentity(markdown: string): { handle: string; id: string } {
  const author = /\[@([A-Za-z0-9_]+)\]\(https:\/\/x\.com\/\1\)/i.exec(markdown);
  if (!author) throw new Error("X discussion primary identity is missing");
  const handle = author[1]!.toLowerCase();
  const timestamp = new RegExp(`\\[[^\\]]*\\]\\(https://x\\.com/${handle}/status/(\\d+)(?:/history)?\\)`, "i").exec(markdown.slice(author.index + author[0].length));
  if (!timestamp?.[1]) throw new Error("X discussion primary timestamp identity is missing");
  const id = timestamp[1];
  headerLength(markdown, handle);
  return { handle, id };
}

export function parseDiscussionPost(markdown: string, handle: string, id: string): ScanItem {
  // Lazy profile avatars are interface decoration; attached media uses /media/ and stays intact.
  markdown = markdown.replace(/!\[[^\]]*\]\(https:\/\/pbs\.twimg\.com\/profile_images\/[^\s)]+\)/g, "");
  if (new RegExp(`/status/${id}/analytics\\)`, "i").test(markdown)) return parseXPost(markdown, handle, id);
  const offset = headerLength(markdown, handle);
  const timestamp = new RegExp(`\\[[^\\]]*\\]\\(https://x\\.com/${handle}/status/${id}(?:/history)?\\)`, "i");
  if (!timestamp.test(markdown) || /\[Show more\]\(/i.test(markdown)) throw new Error("X discussion post identity/content is incomplete");
  const text = markdown.slice(offset).replace(timestamp, "").trim();
  if (!text) throw new Error("X discussion post has no accessible content");
  const url = `https://x.com/${handle}/status/${id}`;
  const media = [...text.matchAll(/!\[[^\]]*\]\((https:\/\/pbs\.twimg\.com\/media\/[^\s)]+)\)/g)].map(match => match[1]!);
  return { id: `x:${id}`, url, title: `@${handle}: ${text.replace(/\s+/g, " ").slice(0, 160)}`,
    publishedAt: new Date(Number((BigInt(id) >> 22n) + 1288834974657n)).toISOString(),
    data: { author: handle, postId: id, url, text, ...(media.length ? { media } : {}) } };
}

function article(handle: string, id: string): string {
  return `article[data-testid="tweet"]:has(a[href="/${handle}/status/${id}" i], a[href="/${handle}/status/${id}/history" i])`;
}

async function read(client: BrowserOsMcpClient, page: number, selector: string): Promise<string> {
  const startedAt = Date.now();
  return readXResult(await checkedCall(client, "read", { page, selector, format: "markdown", includeLinks: true, includeImages: true, viewportOnly: false }), "https://x.com", { startedAt });
}

export async function readXResult(result: unknown, expectedOrigin: string, options: { directory?: string; startedAt?: number } = {}): Promise<string> {
  try { return verifiedReadText(result, expectedOrigin); } catch { /* Only the exact tool-authored overflow contract can recover a truncated read. */ }
  const content = record(result)?.content;
  const blocks = Array.isArray(content) ? content.map(block => record(block)?.text).filter((text): text is string => typeof text === "string" && text.startsWith("[UNTRUSTED_PAGE_CONTENT ")) : [];
  if (blocks.length !== 1) throw new Error("X overflow lacks an unambiguous origin envelope");
  const match = /^([\s\S]*\[END_UNTRUSTED_PAGE_CONTENT nonce=([^\s\]]+)\])\n\nContent truncated at (\d+) chars\. Full content \((\d+) chars\) saved to: ([^\r\n]+)$/.exec(blocks[0]!);
  if (!match || match[1]!.split(`[END_UNTRUSTED_PAGE_CONTENT nonce=${match[2]}]`).length !== 2) throw new Error("X overflow lacks its trusted nonce envelope/suffix");
  const prefix = verifiedReadText({ content: [{ text: match[1] }] }, expectedOrigin);
  const maximum = 4 * 1024 * 1024;
  const declared = Number(match[4]), truncated = Number(match[3]);
  if (!Number.isSafeInteger(declared) || declared > maximum || declared <= truncated || !prefix || Buffer.byteLength(prefix) > truncated) throw new Error("X overflow declared byte size is invalid");
  const directory = resolve(options.directory ?? join(homedir(), ".browseros", "tool-output"));
  const path = match[5]!;
  const filename = /^read-(\d{13})-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:md|txt)$/.exec(basename(path));
  if (!filename || dirname(path) !== directory || resolve(path) !== path) throw new Error("X overflow file path/filename is invalid");
  const startedAt = options.startedAt ?? Date.now();
  if (Number(filename[1]) < startedAt - 5000 || Number(filename[1]) > Date.now() + 1000) throw new Error("X overflow filename timestamp is stale");
  if (await realpath(directory) !== directory) throw new Error("X overflow directory contains a symlink");
  const parent = await stat(directory);
  if (parent.uid !== process.getuid?.() || parent.mode & 0o022) throw new Error("X overflow directory ownership/permissions are unsafe");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.mode & 0o077 || metadata.nlink !== 1) throw new Error("X overflow needs a private regular file");
    if (metadata.size > maximum || metadata.size < declared) throw new Error("X overflow file exceeds its size limit");
    if (metadata.mtimeMs < startedAt - 5000 || metadata.mtimeMs > Date.now() + 1000) throw new Error("X overflow file timestamp is stale");
    const buffer = Buffer.alloc(metadata.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (bytesRead !== metadata.size || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) throw new Error("X overflow file changed during its bounded read");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    const full = verifiedReadText({ content: [{ text: raw }] }, expectedOrigin);
    // Neo labels UTF-8 byte counts as chars and gives the saved copy a separate nonce.
    if (Buffer.byteLength(full) !== declared) throw new Error("X overflow full byte size differs from its trusted suffix");
    if (!full.startsWith(prefix)) throw new Error("X overflow content does not match its current read prefix");
    const current = await lstat(path);
    if (current.dev !== metadata.dev || current.ino !== metadata.ino || !current.isFile() || await realpath(directory) !== directory) throw new Error("X overflow file changed before cleanup");
    await unlink(path);
    return full;
  } finally { await file.close(); }
}

async function ready(client: BrowserOsMcpClient, page: number, selector: string, predicate: (text: string) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const text = await read(client, page, selector);
    if (predicate(text)) return text;
    if (/Something went wrong|Rate limit exceeded|Sign in to X|Log in to X|Verify you are human|Account suspended/i.test(text)) throw new Error("X discussion login/rate-limit/error page");
    if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("X discussion page did not load completely");
}

export async function collectXDiscussions(source: XDiscussionSource, dependencies: SourceDependencies, context?: CollectorContext) {
  assertAllowedOrigin("https://x.com", dependencies.env);
  const client = await (dependencies.createBrowserOsClient ?? createBrowserOsNeoClient)(dependencies.fetch);
  let page: number | undefined;
  try {
    await verifyTools(client);
    await checkedCall(client, "tabs", { action: "list" });
    page = pageId(await checkedCall(client, "tabs", { action: "new", url: "about:blank" }));
    if (page === undefined) throw new Error("BrowserOS did not return a page id");
    const previous = new Map((context?.previousItems ?? []).map(item => [item.id, item]));
    const initial = (context?.bootstrapItemIds ?? []).filter(id => /^x:\d+$/.test(id)).map(id => BigInt(id.slice(2)));
    const cutoff = initial.length ? initial.reduce((a, b) => a > b ? a : b) : undefined;
    const found = new Map<string, { handle: string; id: string }>();
    let boundary: bigint | undefined;
    let overlap = false;
    for (let index = 0; index < source.maxPages; index++) {
      const search = new URL("https://x.com/search");
      search.searchParams.set("q", `${source.query}${boundary === undefined ? "" : ` max_id:${boundary}`}`);
      search.searchParams.set("src", "typed_query");
      search.searchParams.set("f", "live");
      await checkedCall(client, "navigate", { action: "url", page, url: search.href });
      await ready(client, page, "main h1", text => /Search timeline/.test(text));
      const ids: string[] = [];
      for (let cell = 1; cell <= MAX_CELLS; cell++) {
        const selector = `[aria-label="Timeline: Search timeline"] [data-testid="cellInnerDiv"]:nth-child(${cell})`;
        let content = await read(client, page, selector);
        // X renders its heading before the first asynchronous search result.
        if (cell === 1) for (let attempt = 0; attempt < 12 && (!content || content === "(empty)"); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          content = await read(client, page, selector);
        }
        if (content === "(empty)" || content === "") break;
        const identity = primaryXIdentity(content);
        if (boundary !== undefined && BigInt(identity.id) > boundary) throw new Error("X discussion pagination returned an out-of-bound post");
        ids.push(identity.id);
        const key = `x:${identity.id}`;
        if (previous.has(key)) overlap = true;
        if (previous.has(key) || cutoff === undefined || BigInt(identity.id) > cutoff) found.set(key, identity);
        if (cell === MAX_CELLS) throw new Error("X discussion page exceeds the cell limit");
      }
      if (!ids.length) {
        const empty = await read(client, page, "main");
        if (!/No results for|No results found/i.test(empty)) throw new Error("X discussion timeline is incomplete");
        if (previous.size) throw new Error("X discussion search lacks accepted overlap; baseline preserved");
        throw new Error("X discussion search needs a nonempty initial baseline");
      }
      if (!previous.size || overlap) break;
      const minimum = ids.reduce((a, id) => BigInt(id) < a ? BigInt(id) : a, BigInt(ids[0]!));
      if (boundary !== undefined && minimum >= boundary) throw new Error("X discussion pagination stalled");
      boundary = minimum - 1n;
      if (index + 1 === source.maxPages) throw new Error("X discussion page limit reached before accepted overlap");
    }
    const items: ScanItem[] = [];
    let emittedBytes = 2;
    const append = (item: ScanItem) => {
      emittedBytes += Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
      if (emittedBytes > 16 * 1024 * 1024) throw new Error("X discussion observation snapshot exceeds the 16 MiB byte limit");
      items.push(item);
    };
    for (const [key, { handle, id }] of found) {
      const prior = previous.get(key);
      if (context?.newItemsOnly && prior) { append(prior); continue; }
      await checkedCall(client, "navigate", { action: "url", page, url: `https://x.com/${handle}/status/${id}` });
      const selector = article(handle, id);
      const full = await ready(client, page, selector, text => new RegExp(`/status/${id}(?:/history|/analytics)?\\)`, "i").test(text));
      const expansion = await read(client, page, `${selector} [data-testid="tweet-text-show-more-link"]`);
      if (expansion && expansion !== "(empty)") throw new Error("X discussion post remains truncated");
      const item = parseDiscussionPost(full, handle, id);
      const fullText = item.data.text;
      const own = await read(client, page, `${selector} [data-testid="tweetText"]:not([role="link"] [data-testid="tweetText"])`);
      const quoted = await read(client, page, `${selector} [role="link"] [data-testid="tweetText"]`);
      if (own && own !== "(empty)") item.data.text = own;
      if (quoted && quoted !== "(empty)") item.data.quotedText = quoted;
      delete item.data.snippet;
      item.title = `@${handle}: ${String(item.data.text).replace(/\s+/g, " ").slice(0, 160)}`;
      item.data.coverage = COVERAGE;
      if (typeof prior?.data.context === "string") item.data.context = prior.data.context;
      else {
        const parents: string[] = [];
        let reachedTarget = false;
        for (let cell = 1; cell <= MAX_CELLS; cell++) {
          const cellSelector = `[aria-label="Timeline: Conversation"] [data-testid="cellInnerDiv"]:nth-child(${cell}) article`;
          const content = await read(client, page, cellSelector);
          if (!content || content === "(empty)") break;
          // Match the complete primary post, not a quoted permalink in an earlier parent.
          let target: ScanItem | undefined;
          try { target = parseDiscussionPost(content, handle, id); } catch { /* A different primary author/identity can be an ancestor. */ }
          if (target) {
            if (target.data.text === fullText) { reachedTarget = true; break; }
            if (own && own !== "(empty)") {
              // Quote thumbnails load independently; bind the primary timestamp outside quote cards and the exact own text.
              const marker = await read(client, page, `${cellSelector} :is(a[href="/${handle}/status/${id}" i], a[href="/${handle}/status/${id}/history" i]):not([role="link"] a)`);
              const currentOwn = await read(client, page, `${cellSelector} [data-testid="tweetText"]:not([role="link"] [data-testid="tweetText"])`);
              if (new RegExp(`/status/${id}(?:/history)?\\)`, "i").test(marker) && currentOwn === own) { reachedTarget = true; break; }
            }
          }
          const parentId = primaryXIdentity(content);
          const parent = parseDiscussionPost(content, parentId.handle, parentId.id);
          parents.push(`@${parentId.handle}\n${parent.url}\n${String(parent.data.text)}`);
        }
        if (!reachedTarget) throw new Error("X discussion ancestor context lacks the full target post");
        item.data.context = parents.join("\n\n");
      }
      append(item);
    }
    return finish(items, dependencies);
  } finally {
    if (page !== undefined) { try { await checkedCall(client, "tabs", { action: "close", page }); } catch { /* Preserve acquisition outcome. */ } }
    await client.close();
  }
}
