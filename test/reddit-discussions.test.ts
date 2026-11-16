import assert from "node:assert/strict";
import { test } from "node:test";
import { collectRedditDiscussions, createRedditPacer } from "../src/sources/reddit-discussions.ts";

const source = { type: "reddit_discussions" as const, subreddit: "programming", keywords: ["formal verification"], lookbackDays: 7, limit: 100, maxThreads: 100 };
const now = () => new Date("2026-11-16T12:00:00Z");
const entry = (id: string, thread = "abc", content = "Substantial formal verification discussion", date = "2026-11-16T11:00:00Z") => `<entry><id>t1_${id}</id><title>Someone on Unrelated programming news</title><link href="https://www.reddit.com/r/programming/comments/${thread}/title/${id}/"/><updated>${date}</updated><content type="html">${content}</content></entry>`;
const feed = (entries: string) => `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
const direct = async (request: () => Promise<Response>) => request();
function fixture(discovery: string, threads: Record<string, string>) {
  const calls: string[] = [];
  return { calls, dependencies: { now, fetch: async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    return new Response(url.includes("/comments/.rss") ? discovery : threads[new URL(url).pathname] ?? "missing", { status: 200 });
  } } };
}

test("Reddit comment discovery groups off-topic parents and preserves publisher-window limits", async () => {
  const f = fixture(feed(entry("one") + entry("two")), { "/comments/abc/.rss": feed(entry("one") + entry("two") + entry("three", "abc", "A related counterargument")) });
  const result = await collectRedditDiscussions(source, f.dependencies, direct);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.id, "reddit:abc");
  assert.match(String(result.items[0]?.data.coverage), /publisher.*window|window.*publisher/i);
  assert.match(JSON.stringify(result.items[0]?.data.comments), /counterargument/);
  assert.equal(result.items[0]?.data.rootUnavailable, true);
  assert.equal(result.items[0]?.data.body, "");
  assert.equal(f.calls.length, 2);
});

test("Reddit rejects an aggregate thread snapshot above the retained observation bound", async () => {
  const names = ["aaa", "bbb", "ccc", "ddd", "eee", "fff"];
  const large = "x".repeat(3 * 1024 * 1024);
  const threads = Object.fromEntries(names.map(name => [`/comments/${name}/.rss`, feed(entry(name, name) + entry(`${name}extra`, name, large))]));
  const f = fixture(feed(names.map(name => entry(name, name)).join("")), threads);
  await assert.rejects(collectRedditDiscussions(source, f.dependencies, direct), /size|limit|16 MiB/i);
});

test("Reddit new comments revive old threads; old comments stay outside the window", async () => {
  const f = fixture(feed(entry("new", "oldthread") + entry("old", "other", "formal verification", "2020-01-01T00:00:00Z")), { "/comments/oldthread/.rss": feed(entry("new", "oldthread")) });
  assert.deepEqual((await collectRedditDiscussions(source, f.dependencies, direct)).items.map(x => x.id), ["reddit:oldthread"]);
});

test("Reddit malformed identity, conflicting observations, missing triggers, and limits degrade", async () => {
  const missing = fixture(feed(entry("one")), { "/comments/abc/.rss": feed(entry("other")) });
  await assert.rejects(collectRedditDiscussions(source, missing.dependencies, direct), /trigger|discovery/i);
  const conflicting = fixture(feed(entry("one")), { "/comments/abc/.rss": feed(entry("one", "abc", "Changed text")) });
  await assert.rejects(collectRedditDiscussions(source, conflicting.dependencies, direct), /conflict|changed/i);
  const invalid = fixture(feed(entry("one").replace("t1_one", "t1_other")), {});
  await assert.rejects(collectRedditDiscussions(source, invalid.dependencies, direct), /identity/i);
  const limit = fixture(feed(entry("one") + entry("two", "def")), {});
  await assert.rejects(collectRedditDiscussions({ ...source, maxThreads: 1 }, limit.dependencies, direct), /limit/i);
});

test("Reddit thread snapshots are stable under feed entry permutations", async () => {
  const entries = Array.from({ length: 12 }, (_, n) => entry(`c${n}`));
  const original = fixture(feed(entries.join("")), { "/comments/abc/.rss": feed(entries.join("")) });
  const expected = (await collectRedditDiscussions(source, original.dependencies, direct)).items;
  for (let seed = 0; seed < entries.length; seed++) {
    const rotated = [...entries.slice(seed), ...entries.slice(0, seed)];
    const f = fixture(feed(rotated.join("")), { "/comments/abc/.rss": feed(rotated.reverse().join("")) });
    assert.deepEqual((await collectRedditDiscussions(source, f.dependencies, direct)).items, expected);
  }
});

test("Reddit shared pacing serializes requests and honors Retry-After without retrying", async () => {
  let clock = 0;
  const starts: number[] = [];
  const pace = createRedditPacer(() => clock, async ms => { clock += ms; });
  const responses = await Promise.all([
    pace(async () => { starts.push(clock); return new Response("limited", { status: 429, headers: { "Retry-After": "60" } }); }),
    pace(async () => { starts.push(clock); return new Response("ok"); }),
    pace(async () => { starts.push(clock); return new Response("ok"); }),
  ]);
  assert.deepEqual(starts, [0, 61000, 122000]);
  assert.equal(responses[0]?.status, 429);
});

test("Reddit feed context groups matching off-topic threads with nonmatching companions in one request", async () => {
  const companion = "λ  A concrete counterargument.\n  Preserve this spacing.";
  const f = fixture(feed(entry("trigger") + entry("companion", "abc", companion) + entry("older", "abc", "Earlier useful context", "2020-01-01T00:00:00Z") + entry("unrelated", "def", "A different topic")), {});
  const result = await collectRedditDiscussions({ ...source, context: "feed" }, f.dependencies, direct);
  assert.deepEqual(result.items.map(item => item.id), ["reddit:abc"]);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!, /\/r\/programming\/comments\/\.rss\?limit=100$/);
  const item = result.items[0]!;
  assert.equal(item.data.body, "");
  assert.equal(item.data.rootUnavailable, true);
  assert.match(String(item.data.coverage), /subreddit comment-feed window only/i);
  assert.match(String(item.data.coverage), /original post not fetched/i);
  const comments = item.data.comments as Array<{ id: string; body: string }>;
  assert.deepEqual(comments.map(comment => comment.id), ["id:t1_companion", "id:t1_older", "id:t1_trigger"]);
  assert.equal(comments[0]?.body, companion);
});

test("Reddit feed context is invariant under publisher entry order", async () => {
  const entries = Array.from({ length: 12 }, (_, n) => entry(`c${n}`, n % 2 ? "abc" : "def", n === 1 ? "formal verification argument" : `Companion λ ${n}`));
  const baseline = fixture(feed(entries.join("")), {});
  const expected = (await collectRedditDiscussions({ ...source, context: "feed" }, baseline.dependencies, direct)).items;
  for (let rotation = 0; rotation < entries.length; rotation++) {
    const rotated = [...entries.slice(rotation), ...entries.slice(0, rotation)];
    const f = fixture(feed(rotated.join("")), {});
    assert.deepEqual((await collectRedditDiscussions({ ...source, context: "feed" }, f.dependencies, direct)).items, expected);
    assert.equal(f.calls.length, 1);
  }
});
