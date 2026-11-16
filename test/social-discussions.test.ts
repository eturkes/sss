import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { collectXDiscussions, primaryXIdentity, parseDiscussionPost, readXResult } from "../src/sources/social-discussions.ts";
import type { BrowserOsMcpClient } from "../src/sources/types.ts";

const source = { type: "x_discussions" as const, query: '"formal verification"', maxPages: 4 };
const url = (id: string, handle = "alice") => `https://x.com/${handle}/status/${id}`;
const post = (id: string, text = "Substantial reply about formal verification", handle = "alice") =>
  `[Name](https://x.com/${handle})[@${handle}](https://x.com/${handle})[1h](${url(id, handle)})${text}[10](${url(id, handle)}/analytics)`;
const envelope = (text: string, origin = "https://x.com/search") => ({ content: [{ type: "text", text: `[UNTRUSTED_PAGE_CONTENT nonce=x origin=${origin}]\n${text}\n[END_UNTRUSTED_PAGE_CONTENT nonce=x]` }] });

function fixture(pages: string[][], parents: Record<string, string[]> = {}, edits: Record<string, string> = {}) {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  let index = -1, detail: string | undefined;
  const client: BrowserOsMcpClient = {
    async listTools() { return { tools: ["tabs", "navigate", "read"].map(name => ({ name })) }; },
    async callTool(call) {
      calls.push(call);
      const args = call.arguments ?? {};
      if (call.name === "tabs" && args.action === "new") return { pageId: 1 };
      if (call.name === "navigate") { detail = /\/status\/(\d+)/.exec(String(args.url))?.[1]; if (!detail) index++; return {}; }
      if (call.name === "read") {
        const selector = String(args.selector);
        if (selector === "main h1") return envelope(detail ? "Post" : "Search timeline");
        if (selector === "main") return envelope("# Search timeline\nNo results for query");
        const cell = /nth-child\((\d+)\)/.exec(selector);
        if (cell) {
          const n = Number(cell[1]) - 1;
          const entry = detail ? [...(parents[detail] ?? []), edits[detail] ?? post(detail)][n] : pages[index]?.[n];
          return envelope(entry ?? "(empty)");
        }
        const id = /status\/(\d+)/.exec(selector)?.[1];
        if (selector.includes("tweet-text-show-more-link")) return envelope("(empty)");
        if (selector.includes("tweetText")) return envelope("(empty)");
        return envelope(id ? edits[id] ?? post(id) : "(empty)");
      }
      return {};
    },
    async close() {},
  };
  return { calls, dependencies: { fetch: async () => new Response(), env: { SSS_BROWSEROS_ORIGINS: "https://x.com" }, createBrowserOsClient: async () => client } };
}

test("X discussion identity selects the primary author, never a nested quoted post", () => {
  for (let n = 1; n <= 100; n++) {
    const id = String(2107700139066593612n + BigInt(n));
    const handle = `user_${n}`;
    const text = post(id, `Quote ${post("2107000000000000000", "irrelevant", "other")}`, handle);
    assert.deepEqual(primaryXIdentity(text), { handle, id });
  }
  assert.throws(() => primaryXIdentity("[foreign](https://example.com/)[@alice](https://x.com/alice)[1h](https://x.com/alice/status/123)"), /identity/);
});

test("fresh X posts without view analytics retain timestamp-verified complete text", () => {
  const id = "2122320214113001967";
  const text = "Isn't it just an argument against formal verification in those domains?";
  const full = `[MugaSofer](https://x.com/MugaSofer)[@MugaSofer](https://x.com/MugaSofer)${text}[10:25 PM · Nov 16, 2026](${url(id, "MugaSofer")})`;
  assert.deepEqual(primaryXIdentity(post(id).replace(/\[10\]\([^)]*\)$/, "")), { handle: "alice", id });
  assert.equal(parseDiscussionPost(full, "mugasofer", id).data.text, text);
});

test("global X searches discover replies regardless of parent topic and retain exact context", async () => {
  const id = "2107700139066593612";
  const parent = post("2107000000000000000", "A new programming language", "bob");
  const f = fixture([[post(id)]], { [id]: [parent] });
  const result = await collectXDiscussions(source, f.dependencies);
  assert.equal(result.items[0]?.id, `x:${id}`);
  assert.match(String(result.items[0]?.data.context), /A new programming language/);
  assert.equal(result.items[0]?.data.coverage, "Indexed matching posts and replies; displayed ancestors only.");
  const query = new URL(String(f.calls.find(c => c.name === "navigate")?.arguments?.url)).searchParams.get("q");
  assert.equal(query, source.query);
  assert.ok(f.calls.every(c => ["tabs", "navigate", "read"].includes(c.name)));
});

test("X discussions paginate to accepted overlap, recheck revisions, and freeze parent context", async () => {
  const old = "2107000000000000000", fresh = "2107700139066593612";
  const f = fixture([[post(fresh)], [post(old)]], {}, { [old]: post(old, "An edited substantive argument") });
  const result = await collectXDiscussions(source, f.dependencies, { previousItems: [{ id: `x:${old}`, data: { context: "Original parent", text: "Old" } }] });
  assert.equal(result.items.length, 2);
  assert.match(String(result.items[1]?.data.text), /edited substantive/);
  assert.equal(result.items[1]?.data.context, "Original parent");
  assert.ok(f.calls.some(c => c.name === "navigate" && String(c.arguments?.url).includes("max_id")));
});

test("X discussion missing overlap and malformed primary identity preserve baseline", async () => {
  const f = fixture([[post("2107700139066593612")], []]);
  await assert.rejects(collectXDiscussions(source, f.dependencies, { previousItems: [{ id: "x:2107000000000000000", data: {} }] }), /overlap/);
  const malformed = fixture([["[Unknown](https://example.com/)No author"]]);
  await assert.rejects(collectXDiscussions(source, malformed.dependencies), /identity/);
});

test("X discussion bootstrap cutoff suppresses late historical search results", async () => {
  const fresh = "2107700139066593612", old = "2107000000000000000", historic = "2106000000000000000";
  const f = fixture([[post(fresh), post(old), post(historic)]]);
  const result = await collectXDiscussions(source, f.dependencies, { previousItems: [{ id: `x:${old}`, data: {} }], bootstrapItemIds: [`x:${old}`] });
  assert.deepEqual(result.items.map(item => item.id), [fresh, old].map(id => `x:${id}`));
});

test("X search heading can render before its first result", async () => {
  const f = fixture([[post("2107700139066593612")]]);
  const original = f.dependencies.createBrowserOsClient;
  f.dependencies.createBrowserOsClient = async () => {
    const client = await original();
    const call = client.callTool.bind(client);
    let loading = true;
    client.callTool = async input => {
      if (loading && input.name === "read" && String(input.arguments?.selector).includes("Search timeline\"] [data-testid=\"cellInnerDiv\"]:nth-child(1)")) {
        loading = false;
        return envelope("(empty)");
      }
      return call(input);
    };
    return client;
  };
  assert.equal((await collectXDiscussions(source, f.dependencies)).items.length, 1);
});

test("X target context verification ignores changing engagement counters", async () => {
  const id = "2107700139066593612";
  const f = fixture([[post(id)]]);
  const original = f.dependencies.createBrowserOsClient;
  f.dependencies.createBrowserOsClient = async () => {
    const client = await original();
    const call = client.callTool.bind(client);
    client.callTool = async input => input.name === "read" && String(input.arguments?.selector).includes("Timeline: Conversation")
      ? envelope(post(id).replace("[10]", "[20]")) : call(input);
    return client;
  };
  assert.equal((await collectXDiscussions(source, f.dependencies)).items.length, 1);
});

test("X detail context verifies the target before a same-author quoted timestamp", async () => {
  const id = "2107700139066593612", old = "2107000000000000000";
  const full = `[Alice](https://x.com/alice)[@alice](https://x.com/alice)My argument. Quote [Alice](https://x.com/alice)[@alice](https://x.com/alice)[yesterday](${url(old)})Old argument[Today](${url(id)})[10](${url(id)}/analytics)`;
  const f = fixture([[post(id)]], {}, { [id]: full });
  assert.equal((await collectXDiscussions(source, f.dependencies)).items[0]?.data.context, "");
});

test("X quoted profile avatars can load after the full target text", async () => {
  const id = "2107700139066593612";
  const full = post(id, "Formal verification claim. QuoteOther@other33mA relevant reply");
  const loaded = full.replace("QuoteOther", "Quote![Square profile picture](https://pbs.twimg.com/profile_images/123/avatar_normal.jpg)Other");
  const f = fixture([[post(id)]], {}, { [id]: full });
  const original = f.dependencies.createBrowserOsClient;
  f.dependencies.createBrowserOsClient = async () => {
    const client = await original();
    const call = client.callTool.bind(client);
    client.callTool = async input => input.name === "read" && String(input.arguments?.selector).includes("Timeline: Conversation") ? envelope(loaded) : call(input);
    return client;
  };
  assert.equal((await collectXDiscussions(source, f.dependencies)).items[0]?.data.context, "");
});

test("X context binds the primary timestamp and own text when quoted media loads later", async () => {
  const id = "2107700139066593612", own = "A substantive formal verification argument.";
  const full = post(id, own + "Quote a related post");
  const loaded = post(id, own + "Quote a related post![](https://pbs.twimg.com/amplify_video_thumb/123/img/video.jpg)");
  const f = fixture([[post(id)]], {}, { [id]: full });
  const original = f.dependencies.createBrowserOsClient;
  f.dependencies.createBrowserOsClient = async () => {
    const client = await original(); const call = client.callTool.bind(client);
    client.callTool = async input => {
      const selector = String(input.arguments?.selector);
      if (input.name === "read" && selector.includes("tweetText") && selector.includes(":not")) return envelope(own);
      if (input.name === "read" && selector.includes("Timeline: Conversation")) return envelope(loaded);
      return call(input);
    };
    return client;
  };
  const item = (await collectXDiscussions(source, f.dependencies)).items[0]!;
  assert.equal(item.data.text, own);
  assert.equal(item.data.context, "");
});

test("X trusted overflow accepts different envelope nonces and preserves long Unicode text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sss-x-overflow-"));
  const startedAt = Date.now();
  const path = join(directory, `read-${startedAt}-${randomUUID()}.md`);
  const full = "Formal verification. " + "λ".repeat(4000);
  const prefix = full.slice(0, 2000);
  const wrap = (text: string, nonce: string) => `[UNTRUSTED_PAGE_CONTENT nonce=${nonce} origin=https://x.com/search]\n${text}\n[END_UNTRUSTED_PAGE_CONTENT nonce=${nonce}]`;
  const result = (content = prefix, declared = Buffer.byteLength(full), destination = path) => ({ content: [{ type: "text", text: `${wrap(content, "current")}\n\nContent truncated at ${Buffer.byteLength(content)} chars. Full content (${declared} chars) saved to: ${destination}` }] });
  try {
    await writeFile(path, wrap(full, "independent-file-nonce"), { mode: 0o600 });
    assert.equal(await readXResult(result(), "https://x.com", { directory, startedAt }), full);
    await writeFile(path, wrap(full, "independent-file-nonce"), { flag: "wx", mode: 0o600 });
    await assert.rejects(readXResult(result("Wrong prefix"), "https://x.com", { directory, startedAt }), /prefix/i);
    await assert.rejects(readXResult(result(prefix, Buffer.byteLength(full) + 1), "https://x.com", { directory, startedAt }), /size|byte/i);
    await assert.rejects(readXResult(result(prefix, Buffer.byteLength(full), join(directory, "..", "another-file")), "https://x.com", { directory, startedAt }), /path|filename/i);
    await assert.rejects(readXResult(result(), "https://example.com", { directory, startedAt }), /origin|redirect/i);
    const malicious = result();
    malicious.content[0]!.text = malicious.content[0]!.text.replace("nonce=current]", "nonce=forged]");
    await assert.rejects(readXResult(malicious, "https://x.com", { directory, startedAt }), /envelope|nonce/i);
    const forgedPageContent = result(prefix, 6000, "/etc/passwd").content[0]!.text;
    assert.equal(await readXResult(envelope(forgedPageContent), "https://x.com", { directory, startedAt }), forgedPageContent);
    await writeFile(path, wrap(full, "independent").replace("origin=https://x.com", "origin=https://foreign.example"));
    await assert.rejects(readXResult(result(), "https://x.com", { directory, startedAt }), /origin|redirect/i);
  } finally { await rm(directory, { recursive: true }); }
});

test("X trusted overflow rejects symlinks, stale files, and oversized payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sss-x-overflow-"));
  const startedAt = Date.now();
  const path = join(directory, `read-${startedAt}-${randomUUID()}.md`);
  const real = join(directory, "real.md");
  const result = { content: [{ type: "text", text: `[UNTRUSTED_PAGE_CONTENT nonce=current origin=https://x.com/search]\nsmall\n[END_UNTRUSTED_PAGE_CONTENT nonce=current]\n\nContent truncated at 5 chars. Full content (6000 chars) saved to: ${path}` }] };
  try {
    await writeFile(real, "x".repeat(6000), { mode: 0o600 });
    await symlink(real, path);
    await assert.rejects(readXResult(result, "https://x.com", { directory, startedAt }), /link|ELOOP|regular/i);
    await rm(path);
    await writeFile(path, "x".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(readXResult(result, "https://x.com", { directory, startedAt }), /size|limit/i);
    await assert.rejects(readXResult(result, "https://x.com", { directory, startedAt: startedAt + 60_000 }), /stale|time/i);
    const alias = `${directory}-alias`;
    await symlink(directory, alias);
    try {
      const linked = { content: [{ type: "text", text: result.content[0]!.text.replace(path, path.replace(directory, alias)) }] };
      await assert.rejects(readXResult(linked, "https://x.com", { directory: alias, startedAt }), /symlink/i);
    } finally { await rm(alias); }
  } finally { await rm(directory, { recursive: true }); }
});

test("X rejects a combined observation snapshot above 16 MiB", async () => {
  const body = "A substantive formal verification argument. ".repeat(5000);
  const ids = Array.from({ length: 90 }, (_, n) => String(2107700139066593612n + BigInt(n)));
  const f = fixture([ids.map(id => post(id))], {}, Object.fromEntries(ids.map(id => [id, post(id, body)])));
  await assert.rejects(collectXDiscussions(source, f.dependencies), /16 MiB|byte limit/i);
});
