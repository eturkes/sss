import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdir, mkdtemp, readlink, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createPlaywrightSourceSchema } from "../src/config/playwright.ts";
import { htmlSourceSchema } from "../src/config/schema.ts";
import { collectPlaywright } from "../src/sources/playwright.ts";

const schema = createPlaywrightSourceSchema(htmlSourceSchema);
const source = schema.parse({
  type: "playwright", url: "https://fixture.invalid/page", waitForSelector: "article[data-ready]",
  timeoutMs: 60_000,
  itemSelector: "article", fields: { id: { attribute: "id" }, title: { selector: "h2" } },
});
const requests: string[] = [];
const collected = await collectPlaywright(source, {
  now: () => new Date("2026-01-01T00:00:00Z"),
  fetch: async (input) => {
    const url = String(input);
    requests.push(url);
    assert.ok([source.url, "https://fixture.invalid/data"].includes(url));
    return new Response(url.endsWith("/data") ? "Dynamic fixture" : `<html><body><script>
      fetch('/data').then(r => r.text()).then(title => {
        const article = document.createElement('article'); article.id = 'one'; article.dataset.ready = '';
        const h2 = document.createElement('h2'); h2.textContent = title; article.append(h2); document.body.append(article);
      });
    </script></body></html>`, { headers: { "content-type": url.endsWith("/data") ? "text/plain" : "text/html" } });
  },
});
assert.deepEqual(collected.items, [{ id: "id:one", title: "Dynamic fixture", data: { id: "one", title: "Dynamic fixture" } }]);
assert.deepEqual(requests, [source.url, "https://fixture.invalid/data"]);
console.log("PASS dynamic rendering + policy-mediated document/API requests");

let connections = 0;
let datagrams = 0;
const canary = createServer((socket) => { connections += 1; socket.destroy(); });
const udpCanary = createSocket("udp4");
udpCanary.on("message", () => { datagrams += 1; });
await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
await new Promise<void>((resolve) => udpCanary.bind(0, "127.0.0.1", resolve));
const address = canary.address();
assert.ok(address && typeof address === "object");
try {
  const parentNamespace = await readlink("/proc/self/ns/net");
  const artifacts = fileURLToPath(new URL("../.sss/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const profile = await mkdtemp(`${artifacts}playwright-net-probe-`);
  try {
    const wrapper = fileURLToPath(new URL("./playwright-browser.sh", import.meta.url));
    const environment = { ...process.env, SSS_PLAYWRIGHT_EXECUTABLE: process.execPath, SSS_PARENT_NETWORK_NAMESPACE: parentNamespace };
    await assert.rejects(promisify(execFile)(wrapper, [`--user-data-dir=${profile}`], {
      env: { ...environment, PATH: "" }, timeout: 5_000,
    }), /requires bubblewrap/);
    console.log("PASS missing bubblewrap fails closed");
    const code = `
      import {readlink} from 'node:fs/promises'; import {createConnection} from 'node:net'; import {createSocket} from 'node:dgram';
      await new Promise(resolve=>{ const socket=createConnection({host:'127.0.0.1',port:${address.port}});
        socket.on('connect',()=>{socket.destroy();resolve()});socket.on('error',()=>resolve());socket.setTimeout(1000,()=>{socket.destroy();resolve()}); });
      await new Promise(resolve=>{ const socket=createSocket('udp4');socket.send(Buffer.from('canary'),${udpCanary.address().port},'127.0.0.1',()=>{socket.close();resolve()}); });
      console.log(JSON.stringify({namespace:await readlink('/proc/self/ns/net')}));
    `;
    const { stdout } = await promisify(execFile)(wrapper, [
      "--input-type=module", "-e", code, "--", `--user-data-dir=${profile}`,
    ], {
      env: environment,
      timeout: 5_000,
    });
    const child = JSON.parse(stdout) as { namespace: string };
    assert.match(child.namespace, /^net:\[\d+\]$/);
    assert.notEqual(child.namespace, parentNamespace);
    assert.equal(connections, 0);
    assert.equal(datagrams, 0);
    console.log("PASS OS network namespace differs + direct TCP/UDP canaries=0 without Chromium flags");
  } finally {
    await rm(profile, { recursive: true });
  }
  for (const [label, script, expected] of [
    ["private fetch", `fetch('http://127.0.0.1:${address.port}/private')`, /private fixture request rejected/],
    ["WebSocket", `new WebSocket('ws://127.0.0.1:${address.port}/socket')`, /WebSocket/],
    ["POST", `fetch('/write', {method:'POST',body:'x'})`, /method/],
    ["popup", `window.open('https://fixture.invalid/popup')`, /pages|popup/],
  ] as const) {
    await assert.rejects(collectPlaywright(source, {
      fetch: async (input) => {
        if (String(input) !== source.url) throw new Error("private fixture request rejected");
        return new Response(`<html><body><script>${script}</script></body></html>`, { headers: { "content-type": "text/html" } });
      },
    }), expected);
    assert.equal(connections, 0);
    console.log(`PASS ${label} rejected + loopback canary connections=0`);
  }
} finally {
  udpCanary.close();
  await new Promise<void>((resolve, reject) => canary.close((error) => error ? reject(error) : resolve()));
}
