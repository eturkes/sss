import { constants, readlinkSync } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright";

import type { PlaywrightSource } from "../config/playwright.ts";
import { collectHtml } from "./html.ts";
import type { SourceDependencies } from "./types.ts";

export type PlaywrightBrowserLauncher = (options: LaunchOptions) => Promise<Browser>;
type Dependencies = SourceDependencies & { launchPlaywrightBrowser?: PlaywrightBrowserLauncher };

const MAX_CONCURRENT_REQUESTS = 4;
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const RESPONSE_HEADERS = new Set([
  "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers",
  "content-type", "content-language", "content-security-policy", "x-content-type-options",
]);

export async function collectPlaywright(source: PlaywrightSource, dependencies: Dependencies) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Playwright acquisition timeout exceeded")), source.timeoutMs);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let requests = 0;
  let totalBytes = 0;
  let active = 0;
  let pendingRoutes = 0;
  const waiting: Array<() => void> = [];
  const settled: Array<() => void> = [];
  const fail = (error: unknown): void => { if (!controller.signal.aborted) controller.abort(error instanceof Error ? error : new Error(String(error))); };
  const bounded = <T>(promise: Promise<T>): Promise<T> => abortable(promise, controller.signal);
  const addBytes = (size: number): void => {
    totalBytes += size;
    if (totalBytes > source.maxTotalBytes) throw new Error("Playwright total response byte limit exceeded");
  };
  try {
    if (process.platform !== "linux") throw new Error("Playwright sources require Linux and bubblewrap network namespaces");
    // Kernel-backed proc metadata avoids a worker-pool roundtrip consuming short acquisition deadlines.
    const parentNetworkNamespace = readlinkSync("/proc/self/ns/net");
    if (!dependencies.launchPlaywrightBrowser) {
      try { await bounded(access(chromium.executablePath(), constants.X_OK)); } catch {
        throw new Error("Playwright requires bundled Chromium: set PLAYWRIGHT_BROWSERS_PATH to the installed cache and run pnpm exec playwright install chromium --no-shell");
      }
    }
    const launch = dependencies.launchPlaywrightBrowser ?? ((options) => chromium.launch(options));
    const launching = launch({
      executablePath: fileURLToPath(new URL("../../scripts/playwright-browser.sh", import.meta.url)),
      headless: true,
      chromiumSandbox: true,
      timeout: source.timeoutMs,
      // The mandatory network namespace blocks browser egress; these flags also suppress futile browser-owned traffic.
      proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
      args: ["--disable-quic", "--disable-background-networking", "--dns-prefetch-disable", "--host-resolver-rules=MAP * ~NOTFOUND", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      env: {
        ...process.env, DRI_PRIME: "0", __NV_PRIME_RENDER_OFFLOAD: "0", __GLX_VENDOR_LIBRARY_NAME: "mesa",
        SSS_PLAYWRIGHT_EXECUTABLE: chromium.executablePath(),
        SSS_PARENT_NETWORK_NAMESPACE: parentNetworkNamespace,
      },
    });
    void launching.then((value) => { if (controller.signal.aborted) void value.close().catch(() => undefined); }, () => undefined);
    browser = await bounded(launching);
    context = await bounded(browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      javaScriptEnabled: true,
      permissions: [],
      locale: "en-US",
      timezoneId: "UTC",
      viewport: { width: 1280, height: 720 },
    }));
    context.setDefaultTimeout(source.timeoutMs);
    context.setDefaultNavigationTimeout(source.timeoutMs);
    await bounded(context.routeWebSocket(/.*/, async (socket) => {
      fail(new Error("Playwright WebSocket requests are forbidden"));
      await socket.close().catch(() => undefined);
    }));
    await bounded(context.route(/.*/, async (route) => {
      pendingRoutes += 1;
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        const request = route.request();
        let requestPage: Page;
        try { requestPage = request.frame().page(); } catch { throw new Error("Playwright requests from unavailable frames and popups are forbidden"); }
        if (requestPage !== page) throw new Error("Playwright additional pages and popups are forbidden");
        const url = new URL(request.url());
        if (!HTTP_PROTOCOLS.has(url.protocol)) throw new Error("Playwright request protocol is forbidden");
        if (url.username || url.password) throw new Error("Playwright URL credentials are forbidden");
        if (request.method() !== "GET" && request.method() !== "HEAD") throw new Error("Playwright request method is forbidden");
        requests += 1;
        if (requests > source.maxRequests) throw new Error("Playwright request limit exceeded");
        if (active >= MAX_CONCURRENT_REQUESTS) await bounded(new Promise<void>((resolve) => waiting.push(resolve)));
        if (controller.signal.aborted) throw controller.signal.reason;
        active += 1;
        try {
          const response = await bounded(dependencies.fetch(url.href, {
            method: request.method(),
            headers: { Accept: "*/*", "Accept-Language": "en-US" },
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
          }));
          try {
            if (response.status >= 300 && response.status < 400 || response.url && new URL(response.url).href !== url.href) throw new Error("Playwright redirects are forbidden; use the final URL");
            if (!response.ok) throw new Error(`Playwright request failed with HTTP ${response.status}`);
            if (/^\s*attachment(?:\s*;|\s*$)/i.test(response.headers.get("content-disposition") ?? "")) throw new Error("Playwright attachment responses are forbidden");
            const body = await bounded(readBounded(response, source.maxResponseBytes, addBytes, controller.signal));
            const headers: Record<string, string> = {};
            for (const [name, value] of response.headers) if (RESPONSE_HEADERS.has(name)) headers[name] = value;
            await bounded(route.fulfill({ status: response.status, headers, body }));
          } finally {
            if (!response.body?.locked) await response.body?.cancel().catch(() => undefined);
          }
        } finally {
          active -= 1;
          waiting.shift()?.();
        }
      } catch (error) {
        fail(error);
        await route.abort("blockedbyclient").catch(() => undefined);
      } finally {
        pendingRoutes -= 1;
        if (pendingRoutes === 0) for (const release of settled.splice(0)) release();
      }
    }));
    page = await bounded(context.newPage());
    context.on("page", (opened) => {
      if (opened !== page) {
        fail(new Error("Playwright additional pages and popups are forbidden"));
        void opened.close().catch(() => undefined);
      }
    });
    page.on("download", (download) => { fail(new Error("Playwright downloads are forbidden")); void download.cancel().catch(() => undefined); });
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => undefined); });
    const navigation = await bounded(page.goto(source.url, { waitUntil: "domcontentloaded", timeout: source.timeoutMs }));
    if (!navigation?.ok()) throw new Error(`Playwright navigation failed with HTTP ${navigation?.status() ?? "unknown"}`);
    await bounded(page.waitForSelector(source.waitForSelector, { state: "attached", timeout: source.timeoutMs }));
    while (pendingRoutes > 0) await bounded(new Promise<void>((resolve) => settled.push(resolve)));
    const html = await bounded(page.content());
    if (Buffer.byteLength(html) > source.maxResponseBytes) throw new Error("Playwright rendered DOM byte limit exceeded");
    if (controller.signal.aborted) throw controller.signal.reason;
    if (pendingRoutes > 0) throw new Error("Playwright page started new requests during capture; use a complete readiness selector");
    const finalUrl = new URL(page.url());
    if (!HTTP_PROTOCOLS.has(finalUrl.protocol)) throw new Error("Playwright final page protocol is forbidden");
    await bounded(page.close());
    if (controller.signal.aborted) throw controller.signal.reason;
    return await bounded(collectHtml({
      type: "html", url: finalUrl.href, fields: source.fields,
      ...(source.itemSelector === undefined ? {} : { itemSelector: source.itemSelector }),
    }, {
      ...dependencies,
      fetch: async () => Object.defineProperty(new Response(html, { headers: { "content-type": "text/html" } }), "url", { value: finalUrl.href }),
    }));
  } catch (error) {
    fail(error);
    throw controller.signal.reason;
  } finally {
    clearTimeout(timeout);
    controller.abort(new Error("Playwright acquisition closed"));
    for (const release of waiting) release();
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function readBounded(response: Response, maximum: number, addBytes: (size: number) => void, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maximum) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Playwright response byte limit exceeded");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) return Buffer.concat(chunks, size);
      size += result.value.byteLength;
      if (size > maximum) throw new Error("Playwright response byte limit exceeded");
      addBytes(result.value.byteLength);
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then((value) => { signal.removeEventListener("abort", aborted); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}
