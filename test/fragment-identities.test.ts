import assert from "node:assert/strict";
import { test } from "node:test";

import { collectFeed } from "../src/sources/feed.ts";
import { collectHtml } from "../src/sources/html.ts";
import { collectJson } from "../src/sources/json.ts";
import { stableItemId } from "../src/sources/normalize.ts";
import { parseMonitor } from "../src/config/load.ts";
import { semanticMonitorHash } from "../src/config/schema.ts";
import { ScannerEngine } from "../src/core/engine.ts";
import { Store } from "../src/store/database.ts";

const origin = "https://example.com/news/2026.html";
const rss = (entries: string[]) => `<rss><channel>${entries.join("")}</channel></rss>`;
const entry = (title: string, suffix: string) => `<item><title>${title}</title><link>${origin}${suffix}</link><description>Complete ${title}</description></item>`;
const feed = { type: "feed" as const, url: "https://example.com/feed" };

test("URL identities retain meaningful fragments and normalize tracking without changing scholarly identities", () => {
  const identify = (url: string) => stableItemId({ url, fallback: {} });
  assert.equal(identify(`${origin}?utm_source=rss#proof-A`), `url:${origin}#proof-A`);
  assert.notEqual(identify(`${origin}#proof-A`), identify(`${origin}#proof-B`));
  assert.notEqual(identify(`${origin}#Proof`), identify(`${origin}#proof`));
  assert.equal(identify(`${origin}#`), identify(origin));
  assert.equal(identify("https://arxiv.org/abs/2610.12345v2#section"), "arxiv:2610.12345");
  assert.equal(identify("https://doi.org/10.5555/proof#section"), "doi:10.5555/proof");
});

test("RSS and Atom retain each fragment-addressed story and its direct source link", async () => {
  const variants = [
    rss([entry("First", "#first"), entry("Second", "#second")]),
    rss(["first", "second"].map(label => `<item><title>${label}</title><link> </link><link>${origin}#${label}</link></item>`)),
    `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>First</title><link href="${origin}#first"/></entry><entry><title>Second</title><link href="${origin}#second"/></entry></feed>`,
  ];
  for (const body of variants) {
    const result = await collectFeed(feed, { fetch: async () => new Response(body) });
    assert.deepEqual(result.items.map(item => item.id), [`url:${origin}#first`, `url:${origin}#second`]);
    assert.deepEqual(result.items.map(item => item.url), [`${origin}#first`, `${origin}#second`]);
    assert.deepEqual(result.items.map(item => item.data["url"]), result.items.map(item => item.url));
  }
});

test("feed accepts exact duplicates but rejects conflicting records instead of dropping a story", async () => {
  const exact = await collectFeed(feed, { fetch: async () => new Response(rss([entry("First", "#first"), entry("First", "#first")])) });
  assert.equal(exact.items.length, 1);
  await assert.rejects(collectFeed(feed, {
    fetch: async () => new Response(rss([entry("First", ""), entry("Second", "")])),
  }), /conflicting.*identity/i);
  await assert.rejects(collectFeed({ ...feed, keywords: ["First"] }, {
    fetch: async () => new Response(rss([entry("First", ""), entry("Second", "")])),
  }), /conflicting.*identity/i);
});

test("JSON and HTML list extraction retain fragment URLs before identity selection", async () => {
  const suffixes = ["#first", "#second"];
  const json = await collectJson({ type: "json", url: origin }, {
    fetch: async () => Response.json(suffixes.map(url => ({ title: url.slice(1), url }))),
  });
  const fallback = await collectJson({ type: "json", url: origin }, {
    fetch: async () => Response.json(suffixes.map(link => ({ url: " ", link }))),
  });
  const html = await collectHtml({ type: "html", url: origin, itemSelector: "article", fields: {
    title: { selector: "h2" }, url: { selector: "a", attribute: "href" },
  } }, { fetch: async () => new Response(suffixes.map(suffix => `<article><h2>${suffix}</h2><a href="${suffix}">Permalink</a></article>`).join("")) });
  for (const result of [json, fallback, html]) {
    assert.deepEqual(result.items.map(item => item.id), suffixes.map(suffix => `url:${origin}${suffix}`));
    assert.deepEqual(result.items.map(item => item.data[result === fallback ? "link" : "url"]), suffixes.map(suffix => `${origin}${suffix}`));
  }
});

test("DOI-shaped URL anchors cannot override distinct section identities, including URL-valued GUIDs", async () => {
  const urls = ["paper", "review"].map(label => `${origin}#${label}-10.5555/alpha`);
  for (const url of urls) assert.equal(stableItemId({ url, explicit: url, fallback: {} }), `url:${url}`);
  const result = await collectFeed(feed, { fetch: async () => new Response(rss(urls.map((url, index) =>
    `<item><title>Story ${index}</title><guid>${url}</guid><link>${url}</link></item>`))) });
  assert.deepEqual(result.items.map(item => item.id), urls.map(url => `url:${url}`));
});

test("URL extraction preserves exact Unicode and repeated whitespace in fragment identifiers", async () => {
  const suffixes = ["#①", "#1", "#Ａ", "#A", "#a  b", "#a b"];
  const expected = suffixes.map(suffix => new URL(suffix, origin).href);
  const rssResult = await collectFeed(feed, {
    fetch: async () => new Response(rss(suffixes.map((suffix, index) => entry(`Story ${index}`, suffix)))),
  });
  const atom = await collectFeed(feed, { fetch: async () => new Response(`<feed xmlns="http://www.w3.org/2005/Atom">${suffixes.map((suffix, index) =>
    `<entry><title>Story ${index}</title><link href="${origin}${suffix}"/></entry>`).join("")}</feed>`) });
  const json = await collectJson({ type: "json", url: origin }, {
    fetch: async () => Response.json(suffixes.map(url => ({ url }))),
  });
  const mapped = await collectJson({ type: "json", url: origin, fields: { url: { path: "href", type: "string" } } }, {
    fetch: async () => Response.json(suffixes.map(href => ({ href }))),
  });
  const html = await collectHtml({ type: "html", url: origin, itemSelector: "article", fields: {
    url: { selector: "a", attribute: "href", type: "string" },
  } }, { fetch: async () => new Response(suffixes.map(suffix => `<article><a href="${suffix}">Story</a></article>`).join("")) });
  for (const result of [rssResult, atom, json, mapped, html]) {
    assert.deepEqual(result.items.map(item => item.url), expected);
    assert.deepEqual(result.items.map(item => item.id), expected.map(url => `url:${url}`));
  }
});

test("ambiguous feed identities cannot replace the accepted baseline", async t => {
  const monitor = parseMonitor({ version: 1, id: "feed-fragments", name: "Fragments", enabled: true,
    schedule: { every: "1h" }, source: feed, assertions: { allowEmpty: true },
    rules: [{ id: "new", type: "new_items" }],
  });
  const namespace = semanticMonitorHash(monitor);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const now = () => new Date("2026-10-23T10:00:00Z");
  store.syncMonitor(monitor, JSON.stringify(monitor), namespace, now().toISOString());
  let body = rss([entry("Baseline", "#baseline")]);
  const engine = new ScannerEngine(store, () => collectFeed(feed, { fetch: async () => new Response(body), now }), now);
  assert.equal((await engine.run(monitor, namespace, { scheduledFor: "prime" })).status, "ok_unchanged");
  const accepted = [...store.existingItems(monitor.id, namespace)];
  body = rss([entry("First", ""), entry("Second", "")]);
  assert.equal((await engine.run(monitor, namespace, { scheduledFor: "ambiguous" })).status, "degraded");
  assert.deepEqual([...store.existingItems(monitor.id, namespace)], accepted);
  assert.equal(store.events().length, 0);
});

test("accepted feed evidence retains authored link destinations inside mixed content", async t => {
  const monitor = parseMonitor({ version: 1, id: "feed-content", name: "Content", enabled: true,
    schedule: { every: "1h" }, source: feed, assertions: { allowEmpty: true }, rules: [{ id: "new", type: "new_items" }],
  });
  const namespace = semanticMonitorHash(monitor);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const now = () => new Date("2026-10-23T10:00:00Z");
  store.syncMonitor(monitor, JSON.stringify(monitor), namespace, now().toISOString());
  let body = rss([]);
  const collect = () => collectFeed(feed, { fetch: async () => new Response(body), now });
  const engine = new ScannerEngine(store, collect, now);
  await engine.run(monitor, namespace, { scheduledFor: "prime" });
  body = rss([`<item><title>Proof</title><link>${origin}#proof</link><description><p>Details <a href="${origin}#①">first</a> and <a href="${origin}#a  b">second</a>.</p></description></item>`]);
  const expected = (await collect()).items[0]!;
  assert.ok(String(expected.data["summary"]).includes("#①"));
  const result = await engine.run(monitor, namespace, { scheduledFor: "arrival" });
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0]!.after, expected.data);
  assert.deepEqual(JSON.parse(store.existingItems(monitor.id, namespace).get(expected.id)!.data_json), expected.data);
});

test("encoded HTML and CDATA keep exact authored link destinations in feed content", async () => {
  const markup = `<a href="${origin}#Ａ  ①">Proof</a>`;
  for (const description of [
    `<![CDATA[${markup}]]>`,
    markup.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  ]) {
    const result = await collectFeed(feed, { fetch: async () => new Response(rss([
      `<item><title>Proof</title><link>${origin}#post</link><description>${description}</description></item>`,
    ])) });
    assert.equal(result.items[0]!.data["summary"], markup);
  }
});
