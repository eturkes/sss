import assert from "node:assert/strict";
import { test } from "node:test";

import { collectFeed } from "../src/sources/feed.ts";

const source = { type: "feed" as const, url: "https://example.test/feed", identity: "provider" as const };
const rss = (entries: string) => `<rss><channel>${entries}</channel></rss>`;
const item = (id: string, title = "Release") => `<item><guid isPermaLink="false">${id}</guid><title>${title}</title><link>https://example.test/releases</link></item>`;
const dependencies = (xml: string) => ({ fetch: async () => new Response(xml) });

test("provider feed identity preserves distinct authored announcements sharing a destination", async () => {
  const collected = await collectFeed(source, dependencies(rss(item("release-1", "Version 1") + item("release-2", "Version 2"))));
  assert.deepEqual(collected.items.map(value => value.id), ["id:release-1", "id:release-2"]);
  assert.deepEqual(collected.items.map(value => value.url), ["https://example.test/releases", "https://example.test/releases"]);
});

test("provider identity is required even when the entry has a URL or DOI", async () => {
  for (const identity of ["", " \t "]) {
    await assert.rejects(collectFeed(source, dependencies(rss(`<item><guid>${identity}</guid><title>Result</title><link>https://doi.org/10.5555/result</link></item>`))), /provider.*identity|provider.*ID/i);
  }
  await assert.rejects(collectFeed(source, dependencies(rss("<item><title>Missing ID</title><link>https://example.test/release</link></item>"))), /provider.*identity|provider.*ID/i);
});

test("provider feed keeps exact Unicode and whitespace instead of rewriting opaque IDs", async () => {
  const ids = ["  Ａ\t B  ", "A B", "A  B", "Ａ B"];
  const result = await collectFeed(source, dependencies(rss(ids.map((id, index) => item(id, `Result ${index}`)).join(""))));
  assert.deepEqual(result.items.map(value => value.id), ids.map(value => `id:${value}`));
});

test("provider feed rejects conflicting identities before filters and accepts exact duplicates", async () => {
  await assert.rejects(collectFeed({ ...source, keywords: ["Version 1"] }, dependencies(rss(item("release", "Version 1") + item("release", "Version 2")))), /conflicting.*identity/i);
  const exact = await collectFeed(source, dependencies(rss(item("release") + item("release"))));
  assert.deepEqual(exact.items.map(value => value.id), ["id:release"]);
});

test("Atom provider IDs take precedence over scholarly URL identities", async () => {
  const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>urn:release:Ａ 1</id><title>A result</title><link href="https://arxiv.org/abs/2610.12345v2"/></entry></feed>';
  const result = await collectFeed(source, dependencies(xml));
  assert.equal(result.items[0]?.id, "id:urn:release:Ａ 1");
});

test("nested RSS descriptions retain all mixed text, links and their source order", async () => {
  const description = '<p>First <b>proof</b> then <a href="https://example.test/release?a=1&amp;b=2">release</a> end.</p><p>Second paragraph.</p>';
  const result = await collectFeed(source, dependencies(rss(`<item><guid>nested</guid><description>${description}</description></item>`)));
  assert.equal(result.items[0]?.data["summary"], description);
});

test("nested content keeps exact Unicode and whitespace in authored link destinations", async () => {
  const description = '<p>Proof <a href="https://example.test/results#Ａ  ①">link</a>.</p>';
  const result = await collectFeed(source, dependencies(rss(`<item><guid>nested</guid><description>${description}</description></item>`)));
  assert.equal(result.items[0]?.data["summary"], description);
});

test("Atom XHTML retains nested content while escaped HTML and CDATA remain compatible", async () => {
  const xhtml = '<div xmlns="http://www.w3.org/1999/xhtml"><p>One <strong>two</strong> three <a href="https://example.test/proof">proof</a>.</p></div>';
  const variants = [
    { content: `<content type="xhtml">${xhtml}</content>`, expected: xhtml },
    { content: '<content type="html">&lt;p&gt;One &amp; two&lt;/p&gt;</content>', expected: "<p>One & two</p>" },
    { content: '<content><![CDATA[<p>One & two</p>]]></content>', expected: "<p>One & two</p>" },
    { content: '<summary>One &amp; two</summary>', expected: "One & two" },
  ];
  for (const { content, expected } of variants) {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>nested</id>${content}</entry></feed>`;
    const result = await collectFeed(source, dependencies(xml));
    assert.equal(result.items[0]?.data["summary"], expected);
  }
});

test("nested feed content bounds reject without silently truncating observations", async () => {
  const nested = `${"<div>".repeat(65)}complete${"</div>".repeat(65)}`;
  await assert.rejects(collectFeed(source, dependencies(rss(`<item><guid>nested</guid><description>${nested}</description></item>`))), /content.*(bound|depth|limit)/i);
});

test("short Atom summaries do not discard full available content or its keyword matches", async () => {
  const content = '<p>Full proof-body <a href="https://example.test/proof#Ａ  ①">details</a>.</p>';
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>proof</id><summary>Short announcement</summary><content type="xhtml">${content}</content></entry></feed>`;
  const result = await collectFeed({ ...source, keywords: ["proof-body"] }, dependencies(xml));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.data["summary"], "Short announcement");
  assert.equal(result.items[0]!.data["content"], content);
});

test("RSS description and encoded full text both remain available", async () => {
  const content = '<p>Complete announcement <a href="https://example.test/proof#①">details</a>.</p>';
  const xml = `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><guid>proof</guid><description>Short description</description><content:encoded><![CDATA[${content}]]></content:encoded></item></channel></rss>`;
  const result = await collectFeed(source, dependencies(xml));
  assert.equal(result.items[0]!.data["summary"], "Short description");
  assert.equal(result.items[0]!.data["encoded"], content);
});
