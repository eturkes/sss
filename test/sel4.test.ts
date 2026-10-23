import assert from "node:assert/strict";
import { test } from "node:test";

import type { SourceDependencies } from "../src/sources/types.ts";

const INDEX = "https://sel4.systems/news/index.html";
const NOW = new Date("2026-10-23T00:00:00Z");
const article = (year: number, anchor = "same-day", title = "Formal proof", body = "Complete news body") =>
  `<article><a href="#${anchor}"><time datetime="${year}-01-02" id="${anchor}">2 Jan ${year}</time></a><h2>${title}</h2><div class="theprose">${body}</div></article>`;
function page(year: number, years: number[], content = article(year)) {
  return `<html><body><main><h1>seL4 News</h1><nav>${years.map(value => value === year ? `<span>${value}</span>` : `<a href="/news/${value}.html">${value}</a>`).join("")}</nav>${content}</main></body></html>`;
}
function dependencies(responses: Map<string, string | Response>, requested: string[] = []): SourceDependencies {
  return {
    now: () => NOW,
    fetch: async (input, init) => {
      const url = String(input);
      requested.push(url);
      assert.equal(init?.method, "GET");
      const response = responses.get(url);
      assert.ok(response !== undefined, `unlisted request: ${url}`);
      return typeof response === "string" ? new Response(response) : response;
    },
  };
}
async function collect(responses: Map<string, string | Response>, requested?: string[]) {
  const { collectSel4News } = await import("../src/sources/sel4.ts");
  return collectSel4News({ type: "sel4_news" }, dependencies(responses, requested));
}

test("seL4 traverses every publisher archive and retains same-date and cross-year identities", async () => {
  const requested: string[] = [];
  const years = [2024, 2025, 2026];
  const responses = new Map(years.map(year => [year === 2026 ? INDEX : `https://sel4.systems/news/${year}.html`, page(year, years, article(year) + article(year, "other", "Second same-day story"))]));
  const result = await collect(responses, requested);
  assert.equal(result.fetchedAt, NOW.toISOString());
  assert.equal(result.items.length, 6);
  assert.equal(new Set(result.items.map(item => item.id)).size, 6);
  assert.equal(result.items[0]?.url, "https://sel4.systems/news/2026.html#same-day");
  assert.equal(result.items[0]?.id, "url:https://sel4.systems/news/2026.html#same-day");
  assert.equal(result.items[0]?.publishedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(result.items[0]?.data["summary"], "Complete news body");
  assert.deepEqual(requested, [INDEX, "https://sel4.systems/news/2024.html", "https://sel4.systems/news/2025.html"]);
});

test("seL4 rollover uses publisher year instead of host clock and keeps old IDs stable", async () => {
  const before = await collect(new Map([[INDEX, page(2026, [2026])]]));
  const after = await collect(new Map([[INDEX, page(2027, [2026, 2027])], ["https://sel4.systems/news/2026.html", page(2026, [2026, 2027])]]));
  assert.equal(after.items[0]?.url, "https://sel4.systems/news/2027.html#same-day");
  assert.deepEqual(after.items[1], before.items[0]);
});

test("seL4 full traversal preserves arbitrary archive sizes without an editorial cap", async () => {
  const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
  const counts = [9, 33, 22, 23, 20, 21, 20];
  const responses = new Map(years.map((year, index) => [year === 2026 ? INDEX : `https://sel4.systems/news/${year}.html`, page(year, years, Array.from({ length: counts[index]! }, (_, item) => article(year, `story-${item}`)).join(""))]));
  const result = await collect(responses);
  assert.equal(result.items.length, counts.reduce((sum, count) => sum + count, 0));
  assert.equal(new Set(result.items.map(item => item.id)).size, result.items.length);
});

for (const [name, html, pattern] of [
  ["missing navigation", "<main><h1>seL4 News</h1>" + article(2026) + "</main>", /navigation/],
  ["missing current year", page(2026, []), /selected year/],
  ["foreign archive", page(2026, [2025, 2026]).replace("/news/2025.html", "https://evil.test/news/2025.html"), /archive link/],
  ["nested archive navigation", page(2026, [2025, 2026]).replace('<a href="/news/2025.html">2025</a>', '<div><a href="/news/2025.html">2025</a></div>'), /navigation/],
  ["unlisted newer year", page(2025, [2025, 2026]), /newer archive/],
  ["empty corpus", page(2026, [2026], ""), /no articles/],
  ["partial article", page(2026, [2026], article(2026).replace("<h2>Formal proof</h2>", "")), /title/],
  ["empty body", page(2026, [2026], article(2026, "one", "Formal proof", "")), /body/],
  ["date/year mismatch", page(2026, [2026], article(2025)), /date/],
  ["invalid date", page(2026, [2026], article(2026).replace("2026-01-02", "2026-02-30")), /date/],
  ["missing anchor", page(2026, [2026], article(2026).replace('id="same-day"', "")), /anchor/],
  ["anchor/link mismatch", page(2026, [2026], article(2026).replace('href="#same-day"', 'href="#other"')), /anchor/],
  ["duplicate identity", page(2026, [2026], article(2026) + article(2026)), /duplicate/],
] as const) {
  test(`seL4 rejects ${name}`, async () => {
    await assert.rejects(collect(new Map([[INDEX, html]])), pattern);
  });
}

test("seL4 rejects incomplete archives instead of returning a partial corpus", async () => {
  for (const response of [new Response("unavailable", { status: 503 }), page(2025, [2025, 2026], ""), page(2024, [2024, 2026])]) {
    await assert.rejects(collect(new Map([[INDEX, page(2026, [2025, 2026])], ["https://sel4.systems/news/2025.html", response]])), /HTTP|no articles|archive year/);
  }
});

test("seL4 rejects current source failure and redirected source URLs", async () => {
  await assert.rejects(collect(new Map([[INDEX, new Response("unavailable", { status: 503 })]])), /HTTP/);
  const redirected = new Response(page(2026, [2026]));
  Object.defineProperty(redirected, "url", { value: "https://evil.test/news/index.html" });
  await assert.rejects(collect(new Map([[INDEX, redirected]])), /redirect/);
});

test("seL4 acquisition bounds fail closed", async () => {
  const years = Array.from({ length: 257 }, (_, index) => 1770 + index);
  await assert.rejects(collect(new Map([[INDEX, page(years.at(-1)!, years)]])), /archive page limit/);
  await assert.rejects(collect(new Map([[INDEX, page(2026, [2026], article(2026).repeat(10_001))]])), /limit of 10000|limit of 10,000/);
  await assert.rejects(collect(new Map([[INDEX, " ".repeat(4 * 1024 * 1024 + 1)]])), /byte limit/);
  const content = (year: number) => Array.from({ length: 5_001 }, (_, item) => article(year, `story-${item}`)).join("");
  await assert.rejects(collect(new Map([[INDEX, page(2026, [2025, 2026], content(2026))], ["https://sel4.systems/news/2025.html", page(2025, [2025, 2026], content(2025))]])), /limit of 10000|limit of 10,000/);
});

test("seL4 rejects changed archive catalogs and duplicate archive navigation", async () => {
  await assert.rejects(collect(new Map([[INDEX, page(2026, [2025, 2026])], ["https://sel4.systems/news/2025.html", page(2025, [2024, 2025, 2026])]])), /navigation changed/);
  await assert.rejects(collect(new Map([[INDEX, page(2026, [2025, 2026]).replace("</nav>", '<a href="/news/2025.html">2025</a></nav>')]])), /duplicate archive/);
});

test("seL4 ignores footer links and treats body scripts as inert text", async () => {
  const body = `Proof result<script>throw new Error("do not execute")</script><a href="https://evil.test/unlisted">external reference</a>`;
  const html = page(2026, [2026], article(2026, "proof", "Formal proof", body)).replace("</main>", '</main><footer><a href="https://evil.test/news/2025.html">2025</a></footer>');
  const requests: string[] = [];
  const result = await collect(new Map([[INDEX, html]]), requests);
  assert.match(result.items[0]?.data["summary"] as string, /Proof result/);
  assert.deepEqual(requests, [INDEX]);
});

test("seL4 retains ordered unique article links without fetching them", async () => {
  const body = `<p>Proof under <a href="/Verification/assumptions.html#trusted">assumptions</a>.</p><a href="https://proofcraft.systems/news-2026/#proof">Details</a><a href="/Verification/assumptions.html#trusted">Repeated</a><a href="#local-context">Context</a><a href="javascript:throw new Error()">Inert</a><a href="mailto:news@example.test">Contact</a>`;
  const requests: string[] = [];
  const result = await collect(new Map([[INDEX, page(2026, [2026], article(2026, "proof", "Formal proof", body))]]), requests);
  assert.deepEqual(result.items[0]?.data["links"], ["https://sel4.systems/Verification/assumptions.html#trusted", "https://proofcraft.systems/news-2026/#proof", "https://sel4.systems/news/2026.html#local-context"]);
  assert.deepEqual(requests, [INDEX]);
});

test("seL4 retains complete image-only announcements as explicit inert media observations", async () => {
  const requests: string[] = [];
  const body = '<a href="https://www.linuxfoundation.org/resources/publications/annual-report"><img src="../images/lf-annual-report.png" alt="LF annual report"></a>';
  const result = await collect(new Map([[INDEX, page(2026, [2026], article(2026, "lf-annual-report", "seL4 features in the annual report", body))]]), requests);
  assert.equal(result.items[0]?.data["summary"], "LF annual report");
  assert.deepEqual(result.items[0]?.data["media"], [{ type: "image", url: "https://sel4.systems/images/lf-annual-report.png", alt: "LF annual report" }]);
  assert.deepEqual(result.items[0]?.data["links"], ["https://www.linuxfoundation.org/resources/publications/annual-report"]);
  assert.deepEqual(requests, [INDEX]);
});

test("seL4 distinguishes unlabeled image content from empty or unsafe media-only bodies", async () => {
  const result = await collect(new Map([[INDEX, page(2026, [2026], article(2026, "unlabeled", "Unlabeled image", '<img src="../images/report.png">'))]]));
  assert.deepEqual(result.items[0]?.data["media"], [{ type: "image", url: "https://sel4.systems/images/report.png", alt: "" }]);
  assert.equal(result.items[0]?.data["summary"], "Image: https://sel4.systems/images/report.png");
  for (const body of ['<img alt="Missing source">', '<img src="" alt="Empty source">', '<img src="javascript:throw new Error()" alt="Unsafe source">', '<img src="data:image/png;base64,AA==" alt="Inline source">']) {
    await assert.rejects(collect(new Map([[INDEX, page(2026, [2026], article(2026, "bad-media", "Invalid media", body))]])), /body/);
  }
});

for (const target of ["current", "archive"]) {
  test(`seL4 rejects truncated ${target} HTML instead of accepting parser repairs`, async () => {
    const responses = new Map([[INDEX, page(2026, [2025, 2026])], ["https://sel4.systems/news/2025.html", page(2025, [2025, 2026])]]);
    const url = target === "current" ? INDEX : "https://sel4.systems/news/2025.html";
    const complete = responses.get(url)!;
    responses.set(url, complete.slice(0, complete.indexOf("Complete news body") + "Complete news".length));
    await assert.rejects(collect(responses), /incomplete|unclosed/);
  });
}

test("seL4 requires explicit closing tags for critical publisher containers, not optional HTML wrappers", async () => {
  const complete = page(2026, [2026]);
  for (const tag of ["main", "nav", "article", "h2", "div", "a", "time"]) {
    const broken = complete.replace(`</${tag}>`, "");
    await assert.rejects(collect(new Map([[INDEX, broken]])), /incomplete|unclosed|navigation|title|date|body/);
  }
  const withoutWrappers = complete.replace(/<\/?(?:html|body)>/g, "");
  assert.equal((await collect(new Map([[INDEX, withoutWrappers]]))).items.length, 1);
});

test("seL4 truncated acquisition degrades without replacing the persisted accepted baseline", async () => {
  const [{ ScannerEngine }, { Store }] = await Promise.all([import("../src/core/engine.ts"), import("../src/store/database.ts")]);
  const store = new Store(":memory:");
  const config = { id: "sel4-fixture", name: "seL4 fixture", enabled: true, source: { type: "sel4_news" }, rules: [{ id: "changed", type: "field_changed", field: "summary" }], notifications: [{ type: "inbox" }] } as never;
  store.syncMonitor({ id: "sel4-fixture", name: "seL4 fixture", enabled: true }, "{}", "sel4-ns", NOW.toISOString());
  const complete = page(2026, [2026]);
  const responses = [complete, complete.slice(0, complete.indexOf("Complete news body") + "Complete news".length), page(2026, [2026], article(2026, "same-day", "Formal proof", "Recovered news body"))];
  let attempt = 0;
  const engine = new ScannerEngine(store, async () => collect(new Map([[INDEX, responses[attempt++]!]])));
  try {
    await engine.run(config, "sel4-ns", { scheduledFor: "complete" });
    const failed = await engine.run(config, "sel4-ns", { scheduledFor: "truncated" });
    const recovered = await engine.run(config, "sel4-ns", { scheduledFor: "recovered" });
    assert.equal(failed.status, "degraded");
    assert.equal(recovered.events[0]?.before, "Complete news body");
    assert.equal(recovered.events[0]?.after, "Recovered news body");
    assert.equal(store.observations("sel4-fixture").length, 2);
  } finally {
    store.close();
  }
});
