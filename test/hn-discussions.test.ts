import assert from "node:assert/strict";
import { test } from "node:test";

import { collectHnDiscussions, type HnDiscussionsSource } from "../src/sources/hn-discussions.ts";
import type { FetchLike } from "../src/sources/types.ts";

const now = () => new Date("2026-11-16T12:00:00Z");
const epoch = Math.floor(now().getTime() / 1000);
const source: HnDiscussionsSource = { type: "hn_discussions", queries: ["formal verification"], perPage: 2, lookbackDays: 7 };
const hit = (id: number, story = 100, created = epoch - 100) => ({ objectID: String(id), story_id: story, created_at_i: created, _tags: [id === story ? "story" : "comment"] });
const story = (kids: number[] = [101], descendants = kids.length) => ({ id: 100, type: "story", title: "A new programming language", time: epoch - 500_000, by: "author", kids, descendants, url: "https://example.org/article" });
const comment = (id: number, parent = 100, text = "Formal verification proves the implementation satisfies its specification.", kids: number[] = []) => ({ id, type: "comment", parent, text, kids, time: epoch - 100, by: `author-${id}` });
const page = (hits: unknown[], count = hits.length, index = 0, size = 2) => ({ hits, nbHits: count, nbPages: Math.ceil(count / size), page: index, hitsPerPage: size, exhaustiveNbHits: true });
function fixture(searchPages: unknown[], nodes: Record<number, unknown>, requests: URL[] = []): FetchLike {
  return async input => {
    const url = new URL(String(input)); requests.push(url);
    if (url.hostname === "hn.algolia.com") {
      const index = Number(url.searchParams.get("page"));
      return Response.json(searchPages[index]);
    }
    const id = Number(/\/(\d+)\.json$/.exec(url.pathname)?.[1]);
    assert.equal(url.origin, "https://hacker-news.firebaseio.com");
    return Response.json(nodes[id] ?? null);
  };
}

test("HN discovers an off-topic thread from a matching nested comment and preserves the complete discussion", async () => {
  const requests: URL[] = [];
  const text = '<p>Proof: α  → β <a href="https://example.org/# a">details</a></p>';
  const result = await collectHnDiscussions(source, { now, fetch: fixture([page([hit(102)])], {
    100: story([101], 2), 101: comment(101, 100, "Why is this useful?", [102]), 102: comment(102, 101, text),
  }, requests) });
  assert.equal(result.items.length, 1);
  const item = result.items[0]!;
  assert.equal(item.id, "hn:100");
  assert.equal(item.url, "https://news.ycombinator.com/item?id=100");
  assert.equal(item.title, "A new programming language");
  const comments = item.data["comments"] as Record<string, unknown>[];
  assert.deepEqual(comments.map(row => row["id"]), [101, 102]);
  assert.equal(comments[1]?.["text"], text);
  assert.equal(comments[1]?.["parent"], 101);
  assert.ok(JSON.stringify(item.data["comments"]).includes("α  → β"));
  assert.equal(requests[0]?.searchParams.get("tags"), "(story,comment,poll)");
  assert.equal(requests[0]?.searchParams.get("typoTolerance"), "false");
  assert.equal(requests[0]?.searchParams.get("numericFilters"), `created_at_i>=${epoch - 7 * 86400},created_at_i<${epoch}`);
});

test("HN exhausts pages, deduplicates threads across queries, and ignores score/rank churn", async () => {
  const nodes = { 100: story([102, 101], 2), 101: comment(101), 102: comment(102) };
  const fetch = fixture([page([hit(101), hit(102)], 3), page([hit(100)], 3, 1)], nodes);
  const first = await collectHnDiscussions({ ...source, queries: ["formal", "proof"] }, { fetch, now });
  nodes[100] = { ...story([101, 102], 2), ...{ score: 1_000 } };
  const second = await collectHnDiscussions(source, { fetch, now });
  assert.deepEqual(first.items, second.items);
  assert.deepEqual((first.items[0]?.data["comments"] as Record<string, unknown>[]).map(row => row["id"]), [101, 102]);
});

test("HN detects a later comment revision even when the topic title does not change", async () => {
  const nodes: Record<number, unknown> = { 100: story(), 101: comment(101) };
  const fetch = fixture([page([hit(101)])], nodes);
  const first = await collectHnDiscussions(source, { fetch, now });
  nodes[100] = story([101], 2); nodes[101] = comment(101, 100, "Formal verification", [102]); nodes[102] = comment(102, 101, "A concrete proof obligation is ...");
  const second = await collectHnDiscussions(source, { fetch, now });
  assert.equal(first.items[0]?.id, second.items[0]?.id);
  assert.notDeepEqual(first.items[0]?.data, second.items[0]?.data);
});

test("HN accounts for deleted/dead comments while preserving their descendants", async () => {
  const result = await collectHnDiscussions(source, { now, fetch: fixture([page([hit(102)])], {
    100: story([101], 1), 101: { id: 101, type: "comment", parent: 100, deleted: true, kids: [102] }, 102: comment(102, 101),
  }) });
  assert.equal((result.items[0]?.data["comments"] as unknown[]).length, 2);
});

test("HN rejects incomplete, duplicate, approximate, out-of-window, or drifting discovery", async () => {
  const cases = [
    [page([hit(101)], 3)],
    [page([hit(101), hit(101)])],
    [{ ...page([]), exhaustiveNbHits: false }],
    [{ ...page([]), exhaustiveNbHits: undefined }],
    [page([hit(101, 100, epoch)])],
    [page([hit(101, 100, epoch - 8 * 86400)])],
    [page([hit(101), hit(102)], 3), page([hit(103)], 4, 1)],
    [{ ...page([hit(101)]), nbPages: 2 }],
    [page([{ ...hit(101), story_id: "100" }])],
  ];
  for (const pages of cases) await assert.rejects(collectHnDiscussions(source, { now, fetch: fixture(pages, { 100: story(), 101: comment(101) }) }));
});

test("HN rejects missing nodes, wrong parents/identities, cycles, count mismatch, missing matched comments, and limits", async () => {
  const cases: Record<number, unknown>[] = [
    { 100: story() },
    { 100: story(), 101: comment(101, 999) },
    { 100: story(), 101: comment(999) },
    { 100: story(), 101: comment(101, 100, "x", [101]) },
    { 100: story([101], 2), 101: comment(101) },
    { 100: story([102]), 102: comment(102) },
    { 100: { ...story(), title: null }, 101: comment(101) },
  ];
  for (const nodes of cases) await assert.rejects(collectHnDiscussions(source, { now, fetch: fixture([page([hit(101)])], nodes) }));
  await assert.rejects(collectHnDiscussions({ ...source, maxComments: 1 }, { now, fetch: fixture([page([hit(101)])], { 100: story([101, 102], 2), 101: comment(101), 102: comment(102) }) }), /limit/);
  await assert.rejects(collectHnDiscussions({ ...source, maxPages: 1 }, { now, fetch: fixture([page([hit(101), hit(102)], 3)], {}) }), /limit/);
});

test("HN rejects thread changes during acquisition and accepts explicit complete empty discovery", async () => {
  let reads = 0;
  const baseFetch = fixture([page([hit(101)])], { 100: story(), 101: comment(101) });
  const fetch: FetchLike = async input => {
    if (String(input).endsWith("/100.json") && ++reads === 2) return Response.json(story([101, 102], 2));
    return baseFetch(input);
  };
  await assert.rejects(collectHnDiscussions(source, { now, fetch }), /changed|drift/);
  const empty = await collectHnDiscussions(source, { now, fetch: fixture([page([])], {}) });
  assert.deepEqual(empty.items, []);
});

test("HN enforces the acquisition byte bound before following oversized authored content", async () => {
  const requests: URL[] = [];
  await assert.rejects(collectHnDiscussions(source, { now, fetch: fixture([page([hit(101)])], { 100: { ...story(), text: "x".repeat(16 * 1024 * 1024) }, 101: comment(101) }, requests) }), /byte limit/);
  assert.equal(requests.length, 2);
});

test("HN generated trees preserve every authored comment and parent edge under discovery/rank permutations (seed 1794835)", async () => {
  let seed = 1794835;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let trial = 0; trial < 32; trial++) {
    const count = 1 + random(40);
    const nodes: Record<number, ReturnType<typeof comment> | ReturnType<typeof story>> = { 100: story([], count) };
    const oracle: { id: number; parent: number; text: string }[] = [];
    for (let offset = 1; offset <= count; offset++) {
      const id = 100 + offset, parent = 100 + random(offset), text = `comment-${random(1_000_000)}: α\n  β`;
      nodes[id] = comment(id, parent, text); nodes[parent]!.kids.unshift(id); oracle.push({ id, parent, text });
    }
    const result = await collectHnDiscussions(source, { now, fetch: fixture([page([hit(100 + count)])], nodes) });
    const actual = result.items[0]?.data["comments"] as { id: number; parent: number; text: string }[];
    assert.deepEqual(actual.map(({ id, parent, text }) => ({ id, parent, text })), oracle);
  }
});
