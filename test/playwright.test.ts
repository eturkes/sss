import assert from "node:assert/strict";
import { readlink } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page, type Route } from "playwright";

import { htmlSourceSchema } from "../src/config/schema.ts";
import { createPlaywrightSourceSchema } from "../src/config/playwright.ts";
import { collectPlaywright, type PlaywrightBrowserLauncher } from "../src/sources/playwright.ts";

const schema = createPlaywrightSourceSchema(htmlSourceSchema);
const source = () => schema.parse({
  type: "playwright", url: "https://example.com/page", waitForSelector: ".ready",
  itemSelector: "article", fields: { id: { attribute: "data-id" }, title: { selector: "h2" }, url: { selector: "a", attribute: "href" } },
});

function fixture(options: { urls?: string[]; method?: string; content?: string; hang?: boolean; websocket?: boolean; popup?: boolean } = {}) {
  let handler: ((route: Route) => Promise<void>) | undefined;
  let websocketHandler: ((socket: { close(): Promise<void> }) => Promise<void>) | undefined;
  let pageHandler: ((page: Page) => void) | undefined;
  const state = { launch: {} as LaunchOptions, context: {} as object, closed: 0, aborted: 0, fulfilled: [] as object[], waited: "", websocketClosed: 0 };
  const page = {
    on() {},
    async goto() {
      if (options.hang) return await new Promise(() => {});
      for (const url of options.urls ?? ["https://example.com/page", "https://example.com/app.js"]) {
        const route = {
          request: () => ({ url: () => url, method: () => options.method ?? "GET", isNavigationRequest: () => url.endsWith("page"), frame: () => ({ page: () => page }) }),
          abort: async () => { state.aborted += 1; },
          fulfill: async (value: object) => { state.fulfilled.push(value); },
        } as unknown as Route;
        await handler?.(route);
      }
      if (options.websocket) await websocketHandler?.({ close: async () => { state.websocketClosed += 1; } });
      if (options.popup) pageHandler?.({ close: async () => {} } as unknown as Page);
      return { ok: () => true, status: () => 200 };
    },
    async waitForSelector(selector: string) { state.waited = selector; },
    async content() { return options.content ?? '<html><body><article data-id="one"><h2>Dynamic</h2><a href="/one">link</a></article></body></html>'; },
    url: () => "https://example.com/page",
    async close() {},
  } as unknown as Page;
  const context = {
    on(event: string, callback: (page: Page) => void) { if (event === "page") pageHandler = callback; },
    async route(_match: unknown, callback: typeof handler) { handler = callback; },
    async routeWebSocket(_match: unknown, callback: typeof websocketHandler) { websocketHandler = callback; },
    async newPage() { return page; },
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async close() { state.closed += 1; },
  } as unknown as BrowserContext;
  const launch: PlaywrightBrowserLauncher = async (launchOptions) => {
    state.launch = launchOptions;
    return { async newContext(value: object) { state.context = value; return context; }, async close() { state.closed += 1; } } as unknown as Browser;
  };
  return { launch, state };
}

const okFetch = async (input: string | URL | Request) => new Response(String(input).endsWith(".js") ? "/* app */" : "<body></body>", { headers: { "content-type": "text/html", "set-cookie": "secret=value", "content-encoding": "identity" } });

test("Playwright schema preserves HTML identity checks and permits only bounded anonymous recipes", () => {
  assert.equal(source().type, "playwright");
  for (const invalid of [
    { headers: { Authorization: { env: "TOKEN" } } }, { waitForSelector: "" }, { timeoutMs: 60_001 },
    { maxRequests: 501 }, { maxResponseBytes: 16_777_217 }, { maxTotalBytes: 67_108_865 },
    { fields: { title: {} } }, { script: "document.body.innerHTML" }, { userDataDir: "/profile" },
  ]) assert.equal(schema.safeParse({ ...source(), ...invalid }).success, false, JSON.stringify(invalid));
});

test("Playwright routes every request through injected fetch and reuses HTML extraction", async () => {
  const { launch, state } = fixture();
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const result = await collectPlaywright(source(), {
    launchPlaywrightBrowser: launch,
    now: () => new Date("2026-10-23T00:00:00Z"),
    fetch: async (url, init) => { requests.push({ url: String(url), init }); return okFetch(url); },
  });
  assert.deepEqual(result.items, [{ id: "url:https://example.com/one", title: "Dynamic", url: "https://example.com/one", data: { id: "one", title: "Dynamic", url: "https://example.com/one" } }]);
  assert.equal(result.fetchedAt, "2026-10-23T00:00:00.000Z");
  assert.equal(state.waited, ".ready");
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ init }) => init?.method === "GET"));
  assert.equal(state.launch.headless, true);
  assert.equal(state.launch.chromiumSandbox, true);
  assert.equal(state.launch.executablePath, fileURLToPath(new URL("../scripts/playwright-browser.sh", import.meta.url)));
  assert.equal(state.launch.env?.SSS_PLAYWRIGHT_EXECUTABLE, chromium.executablePath());
  assert.equal(state.launch.env?.SSS_PARENT_NETWORK_NAMESPACE, await readlink("/proc/self/ns/net"));
  assert.deepEqual(state.launch.proxy, { server: "http://127.0.0.1:9", bypass: "<-loopback>" });
  assert.equal((state.context as { serviceWorkers: string }).serviceWorkers, "block");
  assert.equal((state.context as { acceptDownloads: boolean }).acceptDownloads, false);
  assert.equal(state.closed, 2);
  for (const value of state.fulfilled as Array<{ headers: Record<string, string> }>) assert.equal(value.headers["set-cookie"], undefined);
});

test("Playwright fails closed on policy errors, methods, protocols, websockets and popups", async () => {
  for (const options of [
    { urls: ["https://example.com/page"], reject: true, message: /private address/ },
    { method: "POST", message: /method/ },
    { urls: ["file:///etc/passwd"], message: /protocol/ },
    { websocket: true, message: /WebSocket/ },
    { popup: true, message: /page|popup/ },
  ]) {
    const { launch, state } = fixture(options);
    await assert.rejects(collectPlaywright(source(), { launchPlaywrightBrowser: launch, fetch: async (url) => { if ("reject" in options) throw new Error("private address rejected"); return okFetch(url); } }), options.message);
    assert.equal(state.closed, 2);
    assert.ok(state.aborted > 0 || state.websocketClosed > 0 || "popup" in options);
  }
});

test("Playwright enforces request, response, total, rendered DOM and deadline bounds", async () => {
  for (const [overrides, options, fetch] of [
    [{ maxRequests: 1 }, {}, okFetch],
    [{ maxResponseBytes: 8 }, {}, okFetch],
    [{ maxTotalBytes: 20 }, {}, okFetch],
    [{ maxResponseBytes: 100 }, { content: "x".repeat(101) }, async () => new Response("ok")],
    [{ timeoutMs: 10 }, { hang: true }, okFetch],
  ] as const) {
    const { launch, state } = fixture(options);
    await assert.rejects(collectPlaywright({ ...source(), ...overrides }, { launchPlaywrightBrowser: launch, fetch }), /limit|exceed|timeout/i);
    assert.equal(state.closed, 2);
  }
});

test("Playwright rejects failed HTTP, redirects and attachment responses", async () => {
  for (const response of [
    new Response("not found", { status: 404 }),
    new Response("go", { status: 302, headers: { location: "http://127.0.0.1/" } }),
    new Response("file", { headers: { "content-disposition": "attachment; filename=x" } }),
    Object.defineProperty(new Response("redirected"), "url", { value: "https://example.com/other" }),
  ]) {
    const { launch, state } = fixture();
    await assert.rejects(collectPlaywright(source(), { launchPlaywrightBrowser: launch, fetch: async () => response }), /HTTP|redirect|attachment/i);
    assert.equal(state.closed, 2);
  }
});
