import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { arxivSourceSchema, crossrefSourceSchema } from "../src/config/research.ts";
import { collectArxiv } from "../src/sources/arxiv.ts";
import { collectCrossref } from "../src/sources/crossref.ts";
import type { FetchLike } from "../src/sources/types.ts";

const now = () => new Date("2026-10-23T01:02:03.000Z");
const crossref = (items: unknown[], total = items.length, cursor?: string) => Response.json({
  status: "ok", "message-type": "work-list", message: {
    "total-results": total, items, ...(cursor === undefined ? {} : { "next-cursor": cursor }),
  },
});
const work = (doi: string) => ({ DOI: doi, title: ["Agent evaluation"], abstract: "A reproducible comparison.", author: [{ given: "A.", family: "Researcher" }], published: { "date-parts": [[2026, 10, 22]] } });
const entry = (id: string, published = "2026-10-22T00:00:00Z") => `<entry><id>http://arxiv.org/abs/${id}</id><title>Agent evaluation</title><summary>A reproducible comparison.</summary><published>${published}</published><updated>2026-10-22T01:00:00Z</updated><author><name>A. Researcher</name></author><category term="cs.AI"/></entry>`;
const atom = (entries: string[], total = entries.length, start = 0, size = 2) => new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${size}</opensearch:itemsPerPage>${entries.join("")}</feed>`);
const sleep = async (_milliseconds: number) => {};

test("research schemas bound pagination and reserve the frozen Crossref index bound", () => {
  assert.equal(crossrefSourceSchema.safeParse({ type: "crossref", query: "agents", perPage: 1_001 }).success, false);
  assert.equal(arxivSourceSchema.safeParse({ type: "arxiv", query: "all:agents", maxPages: 101 }).success, false);
  assert.equal(crossrefSourceSchema.safeParse({ type: "crossref", query: "agents", filter: { "until-index-date": "2025" } }).success, false);
  assert.equal(crossrefSourceSchema.safeParse({ type: "crossref", query: "agents", filter: { type: "journal-article,has-abstract:true" } }).success, false);
  assert.equal(arxivSourceSchema.safeParse({ type: "arxiv", query: "all:agents", perPage: 2, maxPages: 2 }).success, true);
});

test("Crossref traverses opaque cursors with frozen filters and DOI identity", async () => {
  const requests: URL[] = [];
  const fetch: FetchLike = async input => {
    const url = new URL(String(input)); requests.push(url);
    return requests.length === 1 ? crossref([work("10.5555/ABC"), work("10.5555/def")], 3, "opaque+/=&") : crossref([work("10.5555/ghi")], 3);
  };
  const result = await collectCrossref({ type: "crossref", query: "coding agents", filter: { type: "journal-article" }, perPage: 2 }, { fetch, now });
  assert.deepEqual(result.items.map(item => item.id), ["doi:10.5555/abc", "doi:10.5555/def", "doi:10.5555/ghi"]);
  assert.equal(result.items[0]?.publishedAt, "2026-10-22T00:00:00.000Z");
  assert.deepEqual(result.items[0]?.data["authors"], ["A. Researcher"]);
  assert.equal(result.items[0]?.data["abstract"], "A reproducible comparison.");
  assert.equal(requests[0]?.origin, "https://api.crossref.org");
  assert.equal(requests[0]?.searchParams.get("cursor"), "*");
  assert.equal(requests[1]?.searchParams.get("cursor"), "opaque+/=&");
  assert.equal(requests[0]?.searchParams.get("filter"), "type:journal-article,until-index-date:2026-10-23T01:02:02");
  assert.equal(requests[0]?.searchParams.get("filter"), requests[1]?.searchParams.get("filter"));
  assert.equal(requests[1]?.searchParams.get("query"), "coding agents");
  assert.equal(result.fetchedAt, now().toISOString());
});

test("Crossref rejects truncation, changed totals, duplicated identities, malformed metadata, and page exhaustion", async () => {
  const cases = [
    [crossref([work("10.5555/a")], 3, "next")],
    [crossref([work("10.5555/a"), work("10.5555/b")], 3)],
    [crossref([work("10.5555/a"), work("10.5555/b")], 3, "next"), crossref([work("10.5555/c")], 4)],
    [crossref([work("10.5555/a"), work("10.5555/A")], 2)],
    [crossref([work("not-a-doi")], 1)],
    [crossref([{ ...work("10.5555/a"), published: { "date-parts": [[2026, 2, 30]] } }], 1)],
    [Response.json({ status: "ok", message: { items: [] } })],
  ];
  for (const pages of cases) {
    const fetch: FetchLike = async () => pages.shift() ?? new Response("unexpected request", { status: 500 });
    await assert.rejects(collectCrossref({ type: "crossref", query: "agents", perPage: 2 }, { fetch, now }));
  }
  await assert.rejects(collectCrossref({ type: "crossref", query: "agents", perPage: 2, maxPages: 1 }, {
    fetch: async () => crossref([work("10.5555/a"), work("10.5555/b")], 3, "next"), now,
  }), /limit|complete/i);
  assert.equal((await collectCrossref({ type: "crossref", query: "absent" }, { fetch: async () => crossref([]), now })).items.length, 0);
});

test("arXiv paginates exact counts with a frozen query, stable versionless IDs, and canonical links", async () => {
  const requests: URL[] = [];
  const fetch: FetchLike = async input => {
    requests.push(new URL(String(input)));
    return requests.length === 1 ? atom([entry("2610.00001v2"), entry("hep-th/9901001v3")], 3) : atom([entry("2610.00003")], 3, 2);
  };
  const result = await collectArxiv({ type: "arxiv", query: "all:agents OR ti:evaluation", perPage: 2 }, { fetch, now, sleep });
  assert.deepEqual(result.items.map(item => item.id), ["arxiv:2610.00001", "arxiv:hep-th/9901001", "arxiv:2610.00003"]);
  assert.equal(result.items[0]?.url, "https://arxiv.org/abs/2610.00001v2");
  assert.equal(result.items[0]?.data["abstract"], "A reproducible comparison.");
  assert.deepEqual(result.items[0]?.data["categories"], ["cs.AI"]);
  assert.equal(requests[0]?.origin, "https://export.arxiv.org");
  assert.equal(requests[0]?.searchParams.get("search_query"), "(all:agents OR ti:evaluation) AND submittedDate:[199001010000 TO 202610230101]");
  assert.equal(requests[0]?.searchParams.get("search_query"), requests[1]?.searchParams.get("search_query"));
  assert.equal(requests[1]?.searchParams.get("start"), "2");
  assert.equal(requests[1]?.searchParams.get("max_results"), "2");
  assert.equal(requests[1]?.searchParams.get("sortBy"), "submittedDate");
  assert.equal(requests[1]?.searchParams.get("sortOrder"), "ascending");
});

test("arXiv accepts documented element-local namespaces and RFC3339 timezone offsets", async () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
    <opensearch:startIndex xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:startIndex>
    <opensearch:itemsPerPage xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">2</opensearch:itemsPerPage>
    <entry><id xmlns="http://www.w3.org/2005/Atom">http://arxiv.org/abs/hep-ex/0307015</id>
      <title xmlns="http://www.w3.org/2005/Atom">Multi-Electron Production</title><summary>Measured electron production.</summary>
      <published xmlns="http://www.w3.org/2005/Atom">2007-02-27T16:02:02-05:00</published>
      <updated xmlns="http://www.w3.org/2005/Atom">2007-06-25T17:09:59-04:00</updated>
      <author><name>H1 Collaboration</name></author></entry></feed>`;
  const result = await collectArxiv({ type: "arxiv", query: "all:electron", perPage: 2 }, { fetch: async () => new Response(xml), now, sleep });
  assert.equal(result.items[0]?.id, "arxiv:hep-ex/0307015");
  assert.equal(result.items[0]?.publishedAt, "2007-02-27T21:02:02.000Z");
  assert.equal(result.items[0]?.data["updatedAt"], "2007-06-25T21:09:59.000Z");
});

test("arXiv rejects incomplete or drifting pages, error feeds, unsafe XML, and malformed identities", async () => {
  const cases = [
    [atom([entry("2610.00001")], 3)],
    [atom([entry("2610.00001"), entry("2610.00002")], 3), atom([entry("2610.00003")], 3, 1)],
    [atom([entry("2610.00001"), entry("2610.00002")], 3), atom([entry("2610.00003")], 4, 2)],
    [atom([entry("2610.00001v1"), entry("2610.00001v2")], 2)],
    [atom([entry("api/errors#incorrect_id_format")], 1)],
    [atom([entry("2610.00001", "2026-10-24T00:00:00Z")], 1)],
    [atom([entry("2610.00001", "2026-02-30T00:00:00Z")], 1)],
    [atom([entry("2610.00001", "October 22, 2026")], 1)],
    [new Response('<feed xmlns="http://www.w3.org/2005/Atom"><entry>')],
    [new Response('<!DOCTYPE feed [<!ENTITY x "payload">]><feed>&x;</feed>')],
  ];
  for (const pages of cases) {
    const fetch: FetchLike = async () => pages.shift() ?? new Response("unexpected request", { status: 500 });
    await assert.rejects(collectArxiv({ type: "arxiv", query: "all:agents", perPage: 2 }, { fetch, now, sleep }));
  }
  await assert.rejects(collectArxiv({ type: "arxiv", query: "all:agents", perPage: 2, maxPages: 1 }, {
    fetch: async () => atom([entry("2610.00001"), entry("2610.00002")], 3), now, sleep,
  }), /limit|complete/i);
  assert.equal((await collectArxiv({ type: "arxiv", query: "all:absent", perPage: 2 }, { fetch: async () => atom([], 0), now, sleep })).items.length, 0);
});

test("arXiv serializes independent scans through body consumption and spaces request starts", async context => {
  const instant = performance.now() + 4_000;
  context.mock.method(performance, "now", () => instant);
  context.mock.method(Date, "now", () => -1_000);
  let active = 0;
  let maximum = 0;
  const sleeps: number[] = [];
  const fetch: FetchLike = async () => {
    active++;
    maximum = Math.max(maximum, active);
    const text = await atom([], 0).text();
    return new Response(new ReadableStream({
      async start(controller) {
        await new Promise<void>(resolve => setImmediate(resolve));
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
        active--;
      },
    }));
  };
  const dependencies = { fetch, now, sleep: async (milliseconds: number) => { sleeps.push(milliseconds); } };
  await Promise.all([
    collectArxiv({ type: "arxiv", query: "all:first", perPage: 2 }, dependencies),
    collectArxiv({ type: "arxiv", query: "all:second", perPage: 2 }, dependencies),
  ]);
  assert.equal(maximum, 1);
  assert.deepEqual(sleeps, [3_000]);
});
