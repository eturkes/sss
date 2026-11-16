import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { corpusUrl, mutateDiscussionInput, replayDiscussionInput, type DiscussionFuzzInput } from "../scripts/fuzz-discussions.ts";

test("discussion fuzz seed/crash corpus preserves identities and authored text", async () => {
  const inputs = JSON.parse(await readFile(corpusUrl, "utf8")) as DiscussionFuzzInput[];
  assert.ok(inputs.length >= 4);
  const targets = new Set<string>();
  for (const input of inputs) if (await replayDiscussionInput(input)) targets.add(input.target);
  assert.deepEqual([...targets].sort(), ["discourse", "discourse_mark", "hn", "lobsters", "x"]);
});

test("discussion fuzz mutations remain finite JSON inputs, including a minimized empty payload (seed 1794835)", () => {
  let state = 1794835;
  const random = (max: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  let input: DiscussionFuzzInput = { target: "hn", payload: [] };
  for (let i = 0; i < 1000; i++) {
    input = mutateDiscussionInput(input, random);
    assert.equal(input.target, "hn");
    assert.ok(Array.isArray(input.payload));
    assert.ok(JSON.stringify(input).length <= 65_536);
  }
});
