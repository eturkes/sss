import assert from "node:assert/strict";
import { test } from "node:test";

import { collectFeed } from "../src/sources/feed.ts";
import { extractArxiv } from "../src/sources/normalize.ts";

test("GitHub Atom releases retain distinct full release URL identities", async () => {
  for (const repositoryId of ["1234567", "12345678", "129571436"]) {
    const tags = [
      "v4.36.0-rc1", "v4.35.0", "v4.35.0-rc4", "v4.35.0-rc3", "v4.35.0-rc2",
      "v4.35.0-rc1", "v4.34.0", "v2608.01234", "2608.01234", "release%2Frolling%2F2026.10.23",
    ];
    const urls = tags.map((tag) => `https://github.com/example/verifier/releases/tag/${tag}`);
    const entries = tags.map((tag, index) => `<entry>
      <id>tag:github.com,2008:Repository/${repositoryId}/${tag}</id>
      <title>${tag}</title><updated>2026-10-23T01:00:00Z</updated>
      <link rel="alternate" type="text/html" href="${urls[index]}"/>
    </entry>`).join("");
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
    const collection = await collectFeed({ type: "feed", url: "https://github.com/example/verifier/releases.atom" }, {
      fetch: async () => new Response(atom),
    });
    assert.deepEqual(collection.items.map(({ id }) => id), urls.map((url) => `url:${url}`));
    assert.deepEqual(collection.items.map(({ url }) => url), urls);
    assert.equal(collection.items.some(({ data }) => data["arxivId"] !== undefined), false);
  }
  for (const value of ["2608.01234v3", "arXiv:2608.01234v3", "https://arxiv.org/abs/2608.01234v3", "https://export.arxiv.org/pdf/2608.01234v3.pdf?download=1"]) {
    assert.equal(extractArxiv(value), "2608.01234");
  }
  for (const value of ["hep-th/9901001v2", "arXiv:hep-th/9901001v2", "https://arxiv.org/pdf/hep-th/9901001v2.pdf"]) {
    assert.equal(extractArxiv(value), "hep-th/9901001");
  }
  for (const value of ["https://not-arxiv.org/abs/2608.01234", "https://arxiv.org.attacker.test/abs/2608.01234", "2608.012345", "hep-th/99010012"]) {
    assert.equal(extractArxiv(value), undefined);
  }
});
