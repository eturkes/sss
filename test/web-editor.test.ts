import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store/database.ts";
import { createApp } from "../src/web/app.ts";
import { parseMonitor } from "../src/config/load.ts";

const source = `version: 1\nid: papers\nname: 'Papers </textarea><script>alert(1)</script>'\nenabled: false\nschedule: { every: 30m }\nsource: { type: feed, url: https://example.com/feed }\nrules: [{ id: fresh, type: new_items }]\nnotifications:\n  - type: ntfy\n    url: https://ntfy.example.com/base\n    topic: 'private alerts'\n    token: { env: NTFY_TOKEN }\n`;
const config = parseMonitor({ version: 1, id: "papers", name: "Papers", enabled: false, schedule: { every: "30m" }, source: { type: "feed", url: "https://example.com/feed" }, rules: [{ id: "fresh", type: "new_items" }], notifications: [{ type: "ntfy", url: "https://ntfy.example.com/base", topic: "private alerts", token: { env: "NTFY_TOKEN" } }] });
const headers = { host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", "content-type": "application/x-www-form-urlencoded" };
const revision = "0123456789abcdef";

function fixture(saveRecipe = async (_id: string, _source: string, _revision: string): Promise<unknown> => undefined) {
  const store = new Store(":memory:");
  store.syncMonitor(config, JSON.stringify(config), "namespace", new Date().toISOString());
  const app = createApp(store, { run: async () => {}, sync: async () => {}, recipe: async (id: string) => id === "papers" ? { config, source, revision } : undefined, saveRecipe }, { port: 7337, token: "test-token" });
  return { store, app };
}

function form(yaml: string, csrf = "test-token") {
  return new URLSearchParams({ csrf, source: yaml, revision }).toString();
}

test("recipe editor escapes YAML, supplies concurrency token, and links from the dashboard", async () => {
  const { app, store } = fixture();
  try {
    const response = await app.request("http://127.0.0.1:7337/recipes/papers", { headers });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /name="source"/);
    assert.match(body, /name="revision" value="0123456789abcdef"/);
    assert.match(body, /&lt;\/textarea&gt;&lt;script&gt;/);
    assert.doesNotMatch(body, /<script>/);
    assert.match(await (await app.request("http://127.0.0.1:7337/", { headers })).text(), /href="\/recipes\/papers"/);
    assert.equal((await app.request("http://127.0.0.1:7337/recipes/missing", { headers })).status, 404);
  } finally { store.close(); }
});

test("recipe saves validate strict YAML, schema, immutable IDs, and environment-only credentials", async () => {
  const saved: string[][] = [];
  const { app, store } = fixture(async (...args) => { saved.push(args); });
  try {
    for (const invalid of ["version: [", source.replace("id: papers", "id: other"), source.replace("every: 30m", "every: 0s"), source.replace("token: { env: NTFY_TOKEN }", "token: plaintext"), `${source}id: duplicate\n`]) {
      const response = await app.request("http://127.0.0.1:7337/recipes/papers", { method: "POST", headers, body: form(invalid) });
      assert.equal(response.status, 422, invalid);
    }
    assert.equal(saved.length, 0);
    const response = await app.request("http://127.0.0.1:7337/recipes/papers", { method: "POST", headers, body: form(source) });
    assert.equal(response.status, 303);
    assert.deepEqual(saved, [["papers", source, revision]]);
    assert.equal(response.headers.get("location"), "/recipes/papers?saved=1");
  } finally { store.close(); }
});

test("recipe writes reject CSRF, foreign hosts, oversized bodies without a length, and duplicate form keys", async () => {
  let saves = 0;
  const { app, store } = fixture(async () => { saves++; });
  try {
    assert.equal((await app.request("http://127.0.0.1:7337/recipes/papers", { method: "POST", headers, body: form(source, "wrong") })).status, 403);
    assert.equal((await app.request("http://127.0.0.1:7337/recipes/papers", { method: "POST", headers: { ...headers, host: "evil.example" }, body: form(source) })).status, 403);
    assert.equal((await app.request("http://127.0.0.1:7337/recipes/papers", { method: "POST", headers, body: `csrf=test-token&source=${"x".repeat(1_048_577)}` })).status, 413);
    assert.equal((await app.request("http://127.0.0.1:7337/recipes/papers", { method: "POST", headers, body: `${form(source)}&source=other` })).status, 400);
    assert.equal(saves, 0);
  } finally { store.close(); }
});

test("save conflicts preserve submitted source and show an escaped actionable error", async () => {
  const { app, store } = fixture(async () => { throw new Error("Recipe changed <reload>"); });
  try {
    const response = await app.request("http://127.0.0.1:7337/recipes/papers", { method: "POST", headers, body: form(source) });
    assert.equal(response.status, 409);
    const body = await response.text();
    assert.match(body, /Recipe changed &lt;reload&gt;/);
    assert.match(body, /&lt;\/textarea&gt;&lt;script&gt;/);
    assert.match(body, /Reload/);
  } finally { store.close(); }
});

test("mobile onboarding uses exact configured ntfy destinations without exposing credentials or sending", async () => {
  const previous = process.env["NTFY_TOKEN"];
  process.env["NTFY_TOKEN"] = "never-render-me";
  const { app, store } = fixture(async () => { throw new Error("must not save"); });
  try {
    const response = await app.request("http://127.0.0.1:7337/notifications", { headers });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /https:\/\/ntfy\.example\.com\/base\/private%20alerts/);
    assert.match(body, /NTFY_TOKEN/);
    assert.match(body, /ntfy app/);
    assert.match(body, /No test notification/);
    assert.doesNotMatch(body, /never-render-me/);
    assert.doesNotMatch(body, /<script|<img/);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  } finally {
    store.close();
    if (previous === undefined) delete process.env["NTFY_TOKEN"]; else process.env["NTFY_TOKEN"] = previous;
  }
});
