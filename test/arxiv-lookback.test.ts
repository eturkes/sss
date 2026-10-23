import assert from "node:assert/strict";
import { test } from "node:test";

import { arxivSourceSchema } from "../src/config/research.ts";
import { collectArxiv } from "../src/sources/arxiv.ts";

const source = () => arxivSourceSchema.parse({ type: "arxiv", query: 'all:"formal verification"', lookbackDays: 30, perPage: 1 });
const entry = (id: string, published: string) => `<entry><id>https://arxiv.org/abs/${id}</id><title>Verified systems</title><summary>A machine-checked proof.</summary><published>${published}</published><updated>${published}</updated><author><name>A. Author</name></author></entry>`;
const page = (entries: string[], total = entries.length, start = 0) => new Response(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>1</opensearch:itemsPerPage>${entries.join("")}</feed>`);

test("arXiv rolling windows require positive bounded days and preserve legacy source parsing", () => {
  assert.equal(source().lookbackDays, 30);
  for (const lookbackDays of [0, -1, 1.5, 366]) {
    assert.equal(arxivSourceSchema.safeParse({ type: "arxiv", query: "cat:cs.LO", lookbackDays }).success, false);
  }
  assert.equal(arxivSourceSchema.parse({ type: "arxiv", query: "cat:cs.LO" }).lookbackDays, undefined);
});

test("arXiv freezes both rolling bounds across pages and advances them for the next acquisition", async () => {
  let instant = new Date("2026-10-23T01:02:03Z");
  const requests: URL[] = [];
  const result = await collectArxiv(source(), {
    now: () => instant, sleep: async () => {},
    fetch: async input => {
      requests.push(new URL(String(input)));
      instant = new Date("2026-10-24T01:02:03Z");
      return requests.length === 1
        ? page([entry("2610.00001", "2026-09-23T01:01:00Z")], 2)
        : page([entry("2610.00002", "2026-10-22T01:00:00Z")], 2, 1);
    },
  });
  assert.equal(result.items.length, 2);
  const query = '(all:"formal verification") AND submittedDate:[202609230101 TO 202610230101]';
  assert.deepEqual(requests.map(url => url.searchParams.get("search_query")), [query, query]);
  await collectArxiv(source(), {
    now: () => instant, sleep: async () => {},
    fetch: async input => {
      assert.equal(new URL(String(input)).searchParams.get("search_query"), '(all:"formal verification") AND submittedDate:[202609240101 TO 202610240101]');
      return page([]);
    },
  });
});

test("arXiv rejects provider results outside the requested rolling interval", async () => {
  for (const published of ["2026-09-23T01:00:59Z", "2026-10-23T01:02:00Z"]) {
    await assert.rejects(collectArxiv(source(), {
      now: () => new Date("2026-10-23T01:02:03Z"), sleep: async () => {},
      fetch: async () => page([entry("2610.00001", published)]),
    }), /bound/);
  }
});
