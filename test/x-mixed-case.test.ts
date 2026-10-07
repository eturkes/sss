import assert from "node:assert/strict";
import { test } from "node:test";
import { collectX, parseXPost } from "../src/sources/x.ts";
import type { BrowserOsMcpClient } from "../src/sources/types.ts";

test("X acquisition matches mixed-case handles in primary and detail permalink selectors", async () => {
  const id = "2107542088653115603", handle = "ClaudeDevs";
  const link = `https://x.com/${handle}/status/${id}`;
  const header = `[${handle}](https://x.com/${handle})[@${handle}](https://x.com/${handle})`;
  const post = `${header}[15h](${link})Fresh usage allowances soon 👀[34K](${link}/analytics)`;
  const trusted = (text: string) => ({ content: [{ type: "text", text: `[UNTRUSTED_PAGE_CONTENT nonce=case origin=https://x.com/] ${text}\n[END_UNTRUSTED_PAGE_CONTENT nonce=case]` }] });
  let detail = false;
  let closed = false;
  const selected: string[] = [];
  const client: BrowserOsMcpClient = {
    async listTools() { return { tools: ["tabs", "navigate", "read"].map(name => ({ name })) }; },
    async callTool(input) {
      if (input.name === "tabs" && input.arguments?.["action"] === "new") {
        detail = String(input.arguments?.["url"]).includes("/status/");
        return { structuredContent: { pageId: detail ? 2 : 1 } };
      }
      if (input.name !== "read") return {};
      const selector = String(input.arguments?.["selector"]);
      if (selector === "main") return trusted(detail ? `# Post\n${post}` : `# Search timeline\n${post}\n## Search filters`);
      selected.push(selector);
      const attribute = /\[href="([^"]+)"(?:\s+([iIsS]))?\]/.exec(selector);
      assert.ok(attribute, "the permalink read must identify its link");
      const actual = `/${handle}/status/${id}`;
      const matches = attribute[2]?.toLowerCase() === "i" ? attribute[1]!.toLowerCase() === actual.toLowerCase() : attribute[1] === actual;
      if (!matches) return trusted("(empty)");
      if (selector.endsWith('[data-testid="User-Name"]')) return trusted(`${header}[15h](${link})`);
      if (selector.endsWith('[data-testid="tweet-text-show-more-link"]')) return trusted("(empty)");
      if (selector.endsWith('[role="link"] [data-testid="tweetText"]')) return trusted("(empty)");
      if (selector.includes('[data-testid="tweetText"]')) return trusted("Fresh usage allowances soon 👀");
      return trusted(post);
    },
    async close() { closed = true; },
  };
  const result = await collectX({ type: "x", handle, maxPages: 30 }, { fetch: async () => new Response(), env: { SSS_BROWSEROS_ORIGINS: "https://x.com" }, createBrowserOsClient: async () => client });
  assert.equal(result.items[0]?.id, `x:${id}`);
  assert.equal(result.items[0]?.data["author"], "claudedevs");
  assert.equal(result.items[0]?.data["text"], "Fresh usage allowances soon 👀");
  assert.ok(selected.some(selector => selector.endsWith('[data-testid="User-Name"]')));
  assert.ok(selected.some(selector => selector.endsWith('[data-testid="tweet-text-show-more-link"]')));
  assert.equal(closed, true);
});

test("X author headers accept embedded avatars and balanced name labels without accepting a quoted foreign author", () => {
  const id = "2107542088653115603", handle = "ClaudeDevs";
  const profile = `https://x.com/${handle}`, link = `${profile}/status/${id}`;
  const names = ["ClaudeDevs![](https://pbs.twimg.com/profile_images/1798110641414443008/XP8gyBaY_bigger.jpg)", "Claude [Developer [Team]]", "Claude \\[Developer"];
  for (const name of names) {
    const header = `[${name}](${profile})[@${handle}](${profile})`;
    const body = `${header}[15h](${link})Usage refreshed soon[34K](${link}/analytics)`;
    assert.equal(parseXPost(body, "claudedevs", id).data["text"], "Usage refreshed soon");
    assert.throws(() => parseXPost(`[Other](https://x.com/other)[@other](https://x.com/other)Quote${body}`, "claudedevs", id), /author|identity/);
  }
  const avatar = `[![](https://pbs.twimg.com/profile_images/logo.jpg)](${profile})`;
  assert.equal(parseXPost(`${avatar}[Claude](${profile}) [@${handle}](${profile})[15h](${link})Usage refreshed soon[34K](${link}/analytics)`, "claudedevs", id).data["text"], "Usage refreshed soon");
});

test("X waits for thread context to include the fully rendered target avatar", async () => {
  const id = "2107542088653115603", handle = "ClaudeDevs";
  const profile = `https://x.com/${handle}`, link = `${profile}/status/${id}`;
  const plain = `[${handle}](${profile})[@${handle}](${profile})[15h](${link})Usage refreshed soon[34K](${link}/analytics)`;
  const rich = plain.replace(`[${handle}]`, `[${handle}![](https://pbs.twimg.com/profile_images/logo.jpg)]`);
  const parent = "[Parent](https://x.com/parent)[@parent](https://x.com/parent)[1h](https://x.com/parent/status/2107542087243907506)Quota reset question[10K](https://x.com/parent/status/2107542087243907506/analytics)";
  const trusted = (text: string) => ({ content: [{ type: "text", text: `[UNTRUSTED_PAGE_CONTENT nonce=context origin=https://x.com/] ${text}\n[END_UNTRUSTED_PAGE_CONTENT nonce=context]` }] });
  let detail = false, contextReads = 0;
  const client: BrowserOsMcpClient = {
    async listTools() { return { tools: ["tabs", "navigate", "read"].map(name => ({ name })) }; },
    async callTool(input) {
      if (input.name === "tabs" && input.arguments?.["action"] === "new") { detail = String(input.arguments?.["url"]).includes("/status/"); return { structuredContent: { pageId: detail ? 2 : 1 } }; }
      if (input.name !== "read") return {};
      const selector = String(input.arguments?.["selector"]);
      if (selector === "main") return trusted(detail ? `# Post\n# Conversation\n${parent}${++contextReads === 1 ? plain : rich}` : `# Search timeline\n${plain}\n## Search filters`);
      if (selector.endsWith('[data-testid="User-Name"]')) return trusted(`[${handle}](${profile})[@${handle}](${profile})[15h](${link})`);
      if (selector.endsWith('[data-testid="tweet-text-show-more-link"]') || selector.endsWith('[role="link"] [data-testid="tweetText"]')) return trusted("(empty)");
      if (selector.includes('[data-testid="tweetText"]')) return trusted("Usage refreshed soon");
      return trusted(detail ? rich : plain);
    },
    async close() {},
  };
  const result = await collectX({ type: "x", handle, maxPages: 30 }, { fetch: async () => new Response(), env: { SSS_BROWSEROS_ORIGINS: "https://x.com" }, createBrowserOsClient: async () => client });
  assert.match(String(result.items[0]?.data["context"]), /Quota reset question/);
  assert.doesNotMatch(String(result.items[0]?.data["context"]), /Usage refreshed soon/);
  assert.equal(contextReads, 2);
});
