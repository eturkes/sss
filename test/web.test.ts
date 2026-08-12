import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store/database.ts";
import { createApp } from "../src/web/app.ts";

test("dashboard rejects DNS-rebinding hosts and foreign origins", async () => {
  const store = new Store(":memory:");
  const app = createApp(store, { run: async () => {}, sync: async () => {} }, { port: 7337, token: "test-token" });
  assert.equal((await app.request("http://127.0.0.1:7337/", { headers: { host: "attacker.example" } })).status, 403);
  assert.equal((await app.request("http://127.0.0.1:7337/sync", { method: "POST", headers: { host: "127.0.0.1:7337", origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded" }, body: "csrf=test-token" })).status, 403);
  const valid = await app.request("http://127.0.0.1:7337/healthz", { headers: { host: "127.0.0.1:7337" } });
  assert.equal(valid.status, 200);
  assert.match(valid.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  store.close();
});
test("dashboard requires the CSRF token for state-changing requests", async () => {
  const store = new Store(":memory:");
  let syncs = 0;
  const app = createApp(store, { run: async () => {}, sync: async () => { syncs++; } }, { port: 7337, token: "test-token" });
  const denied = await app.request("http://127.0.0.1:7337/sync", { method: "POST", headers: { host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", "content-type": "application/x-www-form-urlencoded" }, body: "csrf=wrong" });
  assert.equal(denied.status, 403);
  assert.equal(syncs, 0);
  const accepted = await app.request("http://127.0.0.1:7337/sync", { method: "POST", headers: { host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", "content-type": "application/x-www-form-urlencoded" }, body: "csrf=test-token" });
  assert.equal(accepted.status, 303);
  assert.equal(syncs, 1);
  store.close();
});
