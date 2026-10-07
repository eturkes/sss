import assert from "node:assert/strict";
import { test } from "node:test";
import { monitorSchema, semanticMonitorHash } from "../src/config/schema.ts";

const config = { version: 1, id: "watch", name: "Watch", enabled: true, schedule: { every: "5m" }, source: { type: "x", handle: "ClaudeDevs" },
  rules: [{ id: "reset", type: "llm_assessment", trigger: "new_item", model: "gpt-6.1-sol", reasoningEffort: "xhigh", prompt: "Assess allowance-reset hints." }] };
test("assessment product selects Claude semantics while Codex defaults retain existing namespaces", () => {
  const claude = { ...config, rules: config.rules.map(rule => ({ ...rule, product: "claude" })) };
  const codex = { ...config, rules: config.rules.map(rule => ({ ...rule, product: "codex" })) };
  const parsed = monitorSchema.parse(claude);
  assert.equal(parsed.rules[0]?.type === "llm_assessment" && parsed.rules[0].product, "claude");
  assert.equal(semanticMonitorHash(config), semanticMonitorHash(codex));
  assert.notEqual(semanticMonitorHash(config), semanticMonitorHash(claude));
  assert.equal(monitorSchema.safeParse({ ...config, rules: config.rules.map(rule => ({ ...rule, product: "other" })) }).success, false);
});
