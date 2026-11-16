import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { pathToFileURL } from "node:url";

import { collectDiscourse } from "../src/sources/discourse.ts";
import { collectHnDiscussions } from "../src/sources/hn-discussions.ts";
import { collectLobsters } from "../src/sources/lobsters.ts";
import { primaryXIdentity } from "../src/sources/social-discussions.ts";
import type { Collection } from "../src/core/types.ts";

export type DiscussionFuzzInput = { target: "hn" | "discourse" | "discourse_mark" | "lobsters" | "x"; payload: unknown[] };
export const corpusUrl = new URL("../test/fixtures/discussion-fuzz.json", import.meta.url);
const now = () => new Date("2026-11-16T12:00:00Z");
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const response = (value: unknown) => new Response(JSON.stringify(value) ?? "");

// Transport is a finite mock: mutated IDs cannot create network requests or unbounded traversals.
// Contract oracles check identities + exact authored text independently of extraction code.
export async function replayDiscussionInput(input: DiscussionFuzzInput): Promise<boolean> {
  let calls = 0;
  let result: Collection;
  try {
    if (input.target === "x") {
      const text = input.payload[0];
      if (typeof text !== "string") return false;
      const id = primaryXIdentity(text);
      assert.match(id.handle, /^[a-z0-9_]+$/);
      assert.match(id.id, /^\d+$/);
      assert.ok(text.toLowerCase().includes(`https://x.com/${id.handle}/status/${id.id}`));
      return true;
    }
    const fetch = async (urlValue: string | URL | Request) => {
      if (++calls > 32) throw new Error("fuzz fixture request limit");
      const url = new URL(String(urlValue));
      if (input.target === "hn") {
        if (url.hostname === "hn.algolia.com") return response(input.payload[0]);
        return response(url.pathname.endsWith("/100.json") ? input.payload[1] : input.payload[2]);
      }
      if ((input.target === "discourse" || input.target === "discourse_mark")) return response(url.pathname === "/search.json" ? input.payload[0] : input.payload[1]);
      return url.pathname === "/search" ? new Response(typeof input.payload[0] === "string" ? input.payload[0] : "") : response(input.payload[1]);
    };
    if (input.target === "hn") result = await collectHnDiscussions({ type: "hn_discussions", queries: ["formal verification"], lookbackDays: 7, perPage: 2, maxPages: 2, maxThreads: 2, maxComments: 4 }, { fetch, now });
    else if ((input.target === "discourse" || input.target === "discourse_mark")) {
      let time = 0;
      result = await collectDiscourse({ type: "discourse", unavailablePosts: input.target === "discourse_mark" ? "mark" : "reject", url: "https://forum.example.test", queries: ["formal verification"], lookbackDays: 30, maxPages: 2, maxTopics: 2, maxPosts: 4 }, { fetch, now }, { now: () => time, wait: async ms => { time += ms; } });
    }
    else result = await collectLobsters({ type: "lobsters", queries: ["formal verification"], lookbackDays: 7, maxPages: 2, maxThreads: 2, maxComments: 4 }, { fetch, now });
  } catch (error) {
    if (error instanceof Error && (error.constructor === Error || error.name === "ZodError")) return false;
    throw error;
  }
  assert.equal(new Set(result.items.map(item => item.id)).size, result.items.length);
  for (const item of result.items) {
    assert.ok(item.id.length > 0);
    assert.match(item.url ?? "", /^https:\/\//);
    if (input.target === "hn") {
      assert.equal(item.id, `hn:${object(input.payload[1])["id"]}`);
      const raw = object(input.payload[2]);
      const comments = item.data["comments"] as Record<string, unknown>[];
      const extracted = comments.find(comment => comment["id"] === raw["id"]);
      if (extracted && raw["text"] !== undefined) assert.equal(extracted["text"], raw["text"]);
    } else if ((input.target === "discourse" || input.target === "discourse_mark")) {
      const root = object(input.payload[1]);
      assert.equal(item.id, `url:https://forum.example.test/t/${root["id"]}`);
      const posts = object(root["post_stream"])["posts"] as Record<string, unknown>[];
      const comments = item.data["comments"] as Record<string, unknown>[];
      for (const post of posts) assert.equal(post["post_number"] === 1 ? item.data["body"] : comments.find(comment => comment["id"] === post["id"])?.["body"], input.target === "discourse_mark" ? post["cooked"] ?? "" : post["cooked"]);
    } else {
      const root = object(input.payload[1]);
      assert.equal(item.id, `lobsters:${root["short_id"]}`);
      const raw = root["comments"] as Record<string, unknown>[];
      const comments = item.data["comments"] as Record<string, unknown>[];
      for (const comment of raw) assert.equal(comments.find(value => value["id"] === comment["short_id"])?.["body"], comment["comment"]);
    }
  }
  return true;
}

type Path = (string | number)[];
export function mutateDiscussionInput(input: DiscussionFuzzInput, random: (maximum: number) => number): DiscussionFuzzInput {
  const copy = structuredClone(input);
  const paths: Path[] = [];
  function visit(value: unknown, path: Path): void {
    paths.push(path);
    if (Array.isArray(value)) value.forEach((part, i) => visit(part, [...path, i]));
    else if (value !== null && typeof value === "object") for (const [key, part] of Object.entries(value)) visit(part, [...path, key]);
  }
  copy.payload.forEach((value, i) => visit(value, [i]));
  if (!paths.length) { copy.payload.push(null); return copy; }
  const path = paths[random(paths.length)]!;
  let parent: any = copy.payload;
  for (const key of path.slice(0, -1)) parent = parent[key];
  const key = path.at(-1)!, original = parent[key];
  const choices: unknown[] = [null, true, false, 0, -1, 1, 100, 101, Number.MAX_SAFE_INTEGER, "", "α\n  β", {}, [], [null]];
  if (typeof original === "string") {
    const point = random(original.length + 1);
    const chars = ['"', "<", ">", "[", "]", "(", ")", "\\", "\u0000", "→", "💡", "/", "123"];
    choices.push(original.slice(0, point) + chars[random(chars.length)] + original.slice(point), original.slice(0, point), original + original);
  } else if (typeof original === "number") choices.push(original + 1, original - 1, original + 0.5);
  else if (Array.isArray(original)) choices.push([...original, original[0]], original.slice(1), [...original].reverse());
  if (random(8) === 0) { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
  else parent[key] = choices[random(choices.length)];
  return JSON.stringify(copy).length <= 65_536 ? copy : structuredClone(input);
}

export async function campaign(milliseconds: number, seed = 1794835) {
  const corpus = JSON.parse(await readFile(corpusUrl, "utf8")) as DiscussionFuzzInput[];
  const session = new Session(); session.connect();
  let state = seed >>> 0;
  const random = (maximum: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % maximum; };
  const coverage = new Set<string>();
  let executions = 0, accepted = 0, added = 0;
  await session.post("Profiler.enable");
  await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  async function execute(input: DiscussionFuzzInput): Promise<void> {
    try { if (await replayDiscussionInput(input)) accepted++; }
    catch (error) {
      const artifact = new URL("../.sss/discussion-fuzz-crash.json", import.meta.url);
      await writeFile(artifact, JSON.stringify(input, null, 2) + "\n");
      throw new Error(`Discussion fuzz crash saved to ${artifact.pathname}`, { cause: error });
    }
    executions++;
    const snapshot = await session.post("Profiler.takePreciseCoverage");
    let novel = false;
    for (const script of snapshot.result) {
      if (!/\/src\/sources\/(?:hn-discussions|discourse|lobsters|social-discussions|x)\.ts$/.test(script.url)) continue;
      for (const fn of script.functions) for (const range of fn.ranges) {
        if (!range.count) continue;
        const key = `${script.url}:${range.startOffset}:${range.endOffset}`;
        if (!coverage.has(key)) { coverage.add(key); novel = true; }
      }
    }
    if (novel) { corpus.push(input); added++; }
  }
  const start = performance.now();
  try {
    for (const input of [...corpus]) await execute(input);
    while (performance.now() - start < milliseconds) await execute(mutateDiscussionInput(corpus[random(corpus.length)]!, random));
  } finally { await session.post("Profiler.stopPreciseCoverage"); session.disconnect(); }
  return { seed, executions, accepted, coverageRanges: coverage.size, added, elapsedMs: Math.round(performance.now() - start) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const seconds = Number(process.argv[2] ?? 10);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error("Use a campaign duration from 1 to 60 seconds");
  console.log(JSON.stringify(await campaign(seconds * 1_000)));
}
