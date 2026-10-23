import assert from "node:assert/strict";
import { test } from "node:test";
import { collectX, timelineIds } from "../src/sources/x.ts";
import type { BrowserOsMcpClient } from "../src/sources/types.ts";

const handle = "thsottiaux", id = "2110151780478927344";
const profile = `https://x.com/${handle}`, url = `${profile}/status/${id}`;
const header = `[Tibo](${profile})[@${handle}](${profile})`;

test("X timeline accepts rendered whitespace between the primary handle and clock", () => {
  for (const space of [" ", "\n", "\t", "\n · \n"]) {
    assert.deepEqual(timelineIds(`${header}${space}[1h](${url})Body`, handle), [id]);
  }
  assert.deepEqual(timelineIds(`${header} authored [quote](${url})`, handle), []);
});

test("X authored error phrases remain evidence while incomplete error pages fail closed", async () => {
  const body = "Something went wrong yesterday. Rate limit exceeded? We fixed it. Sign in to X to see the update.";
  const post = `${header}[1h](${url})${body}[10K](${url}/analytics)`;
  const trusted = (text: string) => ({ content: [{ type: "text", text: `[UNTRUSTED_PAGE_CONTENT nonce=phrase origin=https://x.com/] ${text}\n[END_UNTRUSTED_PAGE_CONTENT nonce=phrase]` }] });
  let errorPage = false;
  const client: BrowserOsMcpClient = {
    async listTools() { return { tools: ["tabs", "navigate", "read"].map(name => ({ name })) }; },
    async callTool({ name, arguments: args }) {
      if (name === "tabs" && args?.["action"] === "new") return { structuredContent: { pageId: String(args["url"]).includes("/status/") ? 2 : 1 } };
      if (name !== "read") return {};
      const selector = String(args?.["selector"]);
      if (errorPage) return trusted("Something went wrong. Try again.");
      if (selector === "main") return trusted(args?.["page"] === 2 ? `# Post\n${post}` : `# Search timeline\n${post}`);
      if (selector.endsWith('[data-testid="tweet-text-show-more-link"]') || selector.endsWith('[role="link"] [data-testid="tweetText"]')) return trusted("(empty)");
      if (selector.includes('[data-testid="tweetText"]')) return trusted(body);
      return trusted(post);
    },
    async close() {},
  };
  const dependencies = { fetch: async () => new Response(), env: { SSS_BROWSEROS_ORIGINS: "https://x.com" }, createBrowserOsClient: async () => client };
  const source = { type: "x" as const, handle, maxPages: 30 };
  assert.equal((await collectX(source, dependencies)).items[0]?.data["text"], body);
  errorPage = true;
  await assert.rejects(collectX(source, dependencies), /login|rate-limit|error page/);
});
