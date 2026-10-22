import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import { assessItem } from "../src/codex/assess.ts";
import { loadMonitorById } from "../src/config/load.ts";
import type { ScanItem } from "../src/core/types.ts";

const cases = z.array(z.object({
  id: z.string(), monitor: z.string(), suggestive: z.boolean(),
  observation: z.object({ id: z.string(), url: z.string().optional(), title: z.string().optional(),
    publishedAt: z.string().optional(), data: z.record(z.string(), z.json()) }).strict(),
})).parse(JSON.parse(await readFile(new URL("../test/fixtures/reset-assessments.json", import.meta.url), "utf8")));
const selected = process.argv.slice(2);
for (const id of selected) if (!cases.some(entry => entry.id === id)) throw new Error(`unknown case: ${id}`);
const queue = cases.filter(entry => !selected.length || selected.includes(entry.id));
const directory = resolve(process.env["SSS_MONITORS_DIR"] ?? "monitors");
const monitors = new Map(await Promise.all([...new Set(queue.map(entry => entry.monitor))].map(async id => [id, await loadMonitorById(directory, id)] as const)));
let passed = 0;
let failed = 0;
// Live probes use the production inference contract, but never instantiate a store or delivery worker.
await Promise.all(Array.from({ length: 2 }, async () => {
  for (let entry; (entry = queue.shift());) {
    const rule = monitors.get(entry.monitor)!.rules.find(rule => rule.type === "llm_assessment");
    if (!rule || rule.type !== "llm_assessment") throw new Error(`missing assessment rule: ${entry.monitor}`);
    try {
      const observation: ScanItem = { id: entry.observation.id, data: entry.observation.data };
      for (const key of ["url", "title", "publishedAt"] as const) {
        const value = entry.observation[key];
        if (value !== undefined) observation[key] = value;
      }
      const result = await assessItem(observation, rule);
      const ok = result.suggestive === entry.suggestive;
      if (ok) passed++; else failed++;
      console.log(JSON.stringify({ case: entry.id, expected: entry.suggestive, pass: ok, ...result }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({ case: entry.id, pass: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}));
console.log(JSON.stringify({ passed, failed }));
if (failed) process.exitCode = 1;
