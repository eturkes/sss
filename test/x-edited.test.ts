import assert from "node:assert/strict";
import { test } from "node:test";
import { collectX, parseXPost } from "../src/sources/x.ts";
import type { BrowserOsMcpClient } from "../src/sources/types.ts";

const handle = "thsottiaux", id = "2110151780478927344", knownId = "2109892247580000595";
const profile = `https://x.com/${handle}`, url = `${profile}/status/${id}`;
const header = `[Tibo](${profile})[@${handle}](${profile})`;
const body = "Day 9/ We've rolled out optimizations to how we store state on disk for the chatgpt & codex desktop app that should reduce the amount stored on disk by 60%. Small ship but we've heard enough feedback about power users running out of disk space.";
const edited = `${header}${body}[Last edited8:32 AM · Oct 14, 2026](${url}/history)[2.4M Views](${url}/analytics)[View quotes](${url}/quotes)`;
const known = { id: `x:${knownId}`, data: { author: handle, postId: knownId, text: "Accepted original", url: `${profile}/status/${knownId}` } };

test("X edited permalink verifies history identity and excludes its display clock", () => {
  const item = parseXPost(edited, handle, id);
  assert.equal(item.id, `x:${id}`);
  assert.equal(item.url, url);
  assert.equal(item.data["text"], body);
  assert.deepEqual(parseXPost(edited.replace("8:32 AM · Oct 14, 2026", "9:45 AM · Oct 15, 2026"), handle, id), item);
  assert.equal(parseXPost(edited.replaceAll(handle, "ThSoTtIaUx"), handle, id).data["text"], body);
  assert.throws(() => parseXPost(edited.replaceAll("/history)", "/history/extra)"), handle, id), /author|identity/);
  assert.throws(() => parseXPost(edited.replaceAll("/history)", "/history?fake=1)"), handle, id), /author|identity/);
  assert.throws(() => parseXPost(edited.replace(`[Last edited8:32 AM · Oct 14, 2026](${url}/history)`, ""), handle, id), /author|identity/);
  assert.throws(() => parseXPost(`[Other](https://x.com/other)[@other](https://x.com/other)Quote${edited}`, handle, id), /author|identity/);
  assert.throws(() => parseXPost(edited.replace(`[2.4M Views](${url}/analytics)`, ""), handle, id), /completion/);
});

test("X acquires unseen edited permalink, freezes parent context, and reuses known strict-new payload", async () => {
  const trusted = (text: string) => ({ content: [{ type: "text", text: `[UNTRUSTED_PAGE_CONTENT nonce=edited origin=${url}] ${text}\n[END_UNTRUSTED_PAGE_CONTENT nonce=edited]` }] });
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const parent = "[Parent](https://x.com/parent)[@parent](https://x.com/parent)[1h](https://x.com/parent/status/2110151780478927343)Disk usage question[10K](https://x.com/parent/status/2110151780478927343/analytics)";
  const timeline = `${header}[Oct 14](${url})${body}[2.4M](${url}/analytics)${header}[Oct 13](${profile}/status/${knownId})Known[20K](${profile}/status/${knownId}/analytics)`;
  let closed = false;
  const client: BrowserOsMcpClient = {
    async listTools() { return { tools: ["tabs", "navigate", "read"].map(name => ({ name })) }; },
    async callTool(input) {
      calls.push(input);
      const args = input.arguments;
      if (input.name === "tabs" && args?.["action"] === "new") return { structuredContent: { pageId: String(args["url"]).includes("/status/") ? 2 : 1 } };
      if (input.name !== "read") return {};
      const selector = String(args?.["selector"]);
      if (selector === "main") return trusted(args?.["page"] === 2 ? `## Post\n# Conversation\n${parent}${edited}` : `# Search timeline\n${timeline}`);
      if (selector.endsWith('[data-testid="User-Name"]')) return trusted(`${header}[Oct 14](${profile}/status/${selector.includes(knownId) ? knownId : id})`);
      if (args?.["page"] === 1) return trusted(`${header}[Oct 14](${url})${body}[2.4M](${url}/analytics)`);
      // The edited permalink exposes only its history timestamp, not a canonical href.
      if (!selector.includes(`a[href="/${handle}/status/${id}/history" i]`)) return trusted("(empty)");
      if (selector.endsWith('[data-testid="tweet-text-show-more-link"]') || selector.endsWith('[role="link"] [data-testid="tweetText"]')) return trusted("(empty)");
      if (selector.includes('[data-testid="tweetText"]')) return trusted(body);
      return trusted(edited);
    },
    async close() { closed = true; },
  };
  const result = await collectX({ type: "x", handle, maxPages: 30 }, { fetch: async () => new Response(), env: { SSS_BROWSEROS_ORIGINS: "https://x.com" }, createBrowserOsClient: async () => client }, { previousItems: [known], bootstrapItemIds: [known.id], newItemsOnly: true });
  assert.deepEqual(result.items.map(item => item.id), [`x:${id}`, known.id]);
  assert.equal(result.items[0]?.data["text"], body);
  assert.match(String(result.items[0]?.data["context"]), /Disk usage question/);
  assert.doesNotMatch(String(result.items[0]?.data["context"]), /Day 9|Last edited/);
  assert.deepEqual(result.items[1], known);
  assert.deepEqual(calls.filter(call => call.name === "tabs" && call.arguments?.["action"] === "new").map(call => call.arguments?.["url"]), ["about:blank", url]);
  assert.ok(calls.every(call => ["tabs", "navigate", "read"].includes(call.name)));
  assert.equal(closed, true);
});
