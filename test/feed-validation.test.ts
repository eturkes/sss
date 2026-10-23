import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { monitorSchema } from "../src/config/schema.ts";
import { ScannerEngine } from "../src/core/engine.ts";
import { collectFeed } from "../src/sources/feed.ts";
import { Store } from "../src/store/database.ts";

const now = () => new Date("2026-10-23T00:00:00.000Z");
const source = { type: "feed" as const, url: "https://example.test/feed" };
const item = "<item><guid>stable</guid><title>A result</title><link>https://example.test/result</link></item>";
const rss = (entries: string) => `<rss version="2.0"><channel><title>Results</title>${entries}</channel></rss>`;
const dependencies = (xml: string) => ({ fetch: async () => new Response(xml), now });

test("feed rejects incomplete and malformed XML even when an item can be extracted", async () => {
  for (const xml of [rss(item).replace("</rss>", ""), rss(item).replace("</channel>", ""), `<rss><channel>${item}`, rss(item).replace("</title>", "</different>")]) {
    await assert.rejects(collectFeed(source, dependencies(xml)), /invalid.*XML/);
  }
});

test("feed rejects document types and entity declarations", async () => {
  for (const declaration of [
    '<!DOCTYPE rss SYSTEM "https://example.test/external.dtd">',
    '<!DOCTYPE rss [<!ENTITY item "replacement">]>',
    '<!ENTITY item SYSTEM "file:///etc/passwd">',
  ]) await assert.rejects(collectFeed(source, dependencies(`${declaration}${rss(item)}`)), /unsafe.*XML|invalid.*XML/);
});

test("every declared RSS and Atom entry must be a record; none can silently disappear", async () => {
  for (const xml of [
    rss("<item>corrupt entry</item>"), rss("<item/>"), rss(`${item}<item>corrupt entry</item>`),
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry>corrupt entry</entry></feed>',
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry/></feed>',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><item>corrupt entry</item></rdf:RDF>',
  ]) await assert.rejects(collectFeed(source, dependencies(xml)), /entry.*record/);
});

test("feed requires one supported root and one RSS channel", async () => {
  for (const xml of [
    "<rss/>", "<rss><title>No channel</title></rss>", "<channel/>",
    `${rss("")}<feed xmlns="http://www.w3.org/2005/Atom"><entry>corrupt</entry></feed>`,
    "<rss><channel/><channel><item>corrupt</item></channel></rss>",
  ]) await assert.rejects(collectFeed(source, dependencies(xml)), /invalid.*XML|RSS or Atom|RSS channel/);
});

test("valid empty RSS and Atom feeds remain complete empty observations", async () => {
  for (const xml of [
    rss(""), '<rss version="2.0"><channel/></rss>', '<feed xmlns="http://www.w3.org/2005/Atom"/>',
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty results</title></feed>',
  ]) assert.deepEqual((await collectFeed(source, dependencies(xml))).items, []);
});

test("invalid feed cannot prime or replace a persisted allowEmpty baseline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sss-feed-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.db");
  let store = new Store(path);
  const config = monitorSchema.parse({
    version: 1, id: "results", name: "Results", enabled: true, schedule: { every: "1h" }, source,
    assertions: { allowEmpty: true }, rules: [{ id: "new", type: "new_items", bootstrap: "suppress_existing" }],
    notifications: [{ type: "inbox" }],
  });
  store.syncMonitor(config, JSON.stringify(config), "ns", now().toISOString());
  let xml = rss("<item>corrupt</item>");
  const makeEngine = () => new ScannerEngine(store, async () => collectFeed(source, dependencies(xml)), now);
  let engine = makeEngine();
  assert.equal((await engine.run(config, "ns", { scheduledFor: "invalid-bootstrap" })).status, "degraded");
  assert.equal(store.initialized(config.id, "ns"), false);
  xml = rss(item);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "valid-bootstrap" })).status, "ok_unchanged");
  const accepted = [...store.existingItems(config.id, "ns")];
  assert.equal(accepted.length, 1);
  const observations = store.observations(config.id);
  xml = rss("<item>corrupt</item>");
  assert.equal((await engine.run(config, "ns", { scheduledFor: "invalid-next" })).status, "degraded");
  assert.deepEqual([...store.existingItems(config.id, "ns")], accepted);
  assert.deepEqual(store.observations(config.id), observations);
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.deepEqual([...store.existingItems(config.id, "ns")], accepted);
  engine = makeEngine();
  xml = rss(`${item}<item><guid>new</guid><title>New result</title></item>`);
  const recovered = await engine.run(config, "ns", { scheduledFor: "recovered" });
  assert.equal(recovered.status, "ok_changed");
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.events[0]!.title, "New result");
});
