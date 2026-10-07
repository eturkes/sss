import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChangeEvent } from "../src/core/types.ts";
import { deliver, drainOutbox } from "../src/notifications/outbox.ts";
import { Store } from "../src/store/database.ts";

const config = { type: "email", to: "reader@example.com", from: "sender@example.com", account: "gmail" };
const event: ChangeEvent = {
  id: "assessment-event", monitorId: "codex-reset", runId: "run", namespace: "ns", ruleId: "reset-hint",
  kind: "new_item", itemId: "post", title: "A veiled joke 😄", url: "https://x.com/thsottiaux/status/123",
  reason: "This suggests an incoming Codex usage-limit reset.", before: undefined,
  after: {
    text: `${"Long post 🥳 ".repeat(1_000)}last substantive sentence: fresh limits tomorrow?`,
    assessment: { suggestive: true, reason: "The joke implies refreshed limits.", evidence: ["fresh limits tomorrow?"], model: "gpt-6.1-sol", reasoningEffort: "xhigh" },
  },
  observedAt: "2026-10-07T01:02:03.000Z",
};

async function mockMsmtp(t: TestContext, action = "capture"): Promise<{
  message: string; args: string; helperPid: string; pulse: string; survived: string; succeed: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "sss-email-"));
  const message = join(directory, "message");
  const args = join(directory, "args.json");
  const failure = join(directory, "failure");
  const helperPid = join(directory, "helper-pid");
  const pulse = join(directory, "pulse");
  const survived = join(directory, "survived");
  if (action === "fail") await writeFile(failure, "");
  const recordArgs = `writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)));`;
  const helperProgram = `
    const { existsSync, writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    writeFileSync(${JSON.stringify(helperPid)}, String(process.pid));
    setInterval(() => { if (existsSync(${JSON.stringify(pulse)})) writeFileSync(${JSON.stringify(survived)}, "alive"); }, 5);
  `;
  const program = `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
${action === "descendant" ? `
spawn(process.execPath, ["-e", ${JSON.stringify(helperProgram)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
${recordArgs}` : action === "hang" ? `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); ${recordArgs}` : `
${recordArgs}
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(message)}, data);
  ${action === "fail" ? `if (existsSync(${JSON.stringify(failure)})) { process.stderr.write("password=fixture-secret Bearer credential-value\\n"); process.exitCode = 75; }` : ""}
});`}
`;
  await writeFile(join(directory, "msmtp"), program, { mode: 0o700 });
  const oldPath = process.env["PATH"];
  process.env["PATH"] = `${directory}:${oldPath ?? ""}`;
  t.after(async () => {
    try {
      const pid = Number(await readFile(helperPid, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code)))) throw error;
    }
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
    await rm(directory, { recursive: true, force: true });
  });
  return { message, args, helperPid, pulse, survived, succeed: () => rm(failure, { force: true }) };
}

function parseMessage(message: string): { headers: string; body: string } {
  const separator = message.indexOf("\r\n\r\n");
  assert.ok(separator >= 0, "RFC headers/body separator");
  const headers = message.slice(0, separator);
  assert.equal(/(?<!\r)\n/.test(message), false, "wire line endings are CRLF");
  assert.match(headers, /^Content-Transfer-Encoding: base64$/m);
  const encodedBody = message.slice(separator + 4);
  assert.ok(encodedBody.split("\r\n").every((line) => line.length <= 76), "MIME base64 lines <= 76 bytes");
  return { headers, body: Buffer.from(encodedBody, "base64").toString("utf8") };
}

test("email sends complete UTF-8 evidence through an explicit msmtp recipient", async (t) => {
  const capture = await mockMsmtp(t);
  const unicodeEvent = { ...event, monitorId: "usage-reset-🥳".repeat(12) };
  await deliver(unicodeEvent, "email:0", JSON.stringify(config));
  const args = JSON.parse(await readFile(capture.args, "utf8")) as string[];
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), config.to);
  assert.ok(args.includes(`--from=${config.from}`));
  assert.ok(args.includes(`--account=${config.account}`));
  assert.ok(args.includes("--set-from-header=auto"));
  const wire = await readFile(capture.message, "utf8");
  const { headers, body } = parseMessage(wire);
  assert.match(headers, /^MIME-Version: 1\.0$/m);
  assert.match(headers, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.match(headers, /^From: <sender@example\.com>$/m);
  assert.match(headers, /^To: <reader@example\.com>$/m);
  assert.match(headers, /^Date: Wed, 07 Oct 2026 01:02:03 \+0000$/m);
  const unfolded = headers.replace(/\r\n[ \t]+/g, " ");
  const subject = /^Subject: (.+)$/m.exec(unfolded)?.[1];
  assert.ok(subject);
  const words = [...subject.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
  assert.ok(words.length > 1);
  assert.ok(words.every(([word]) => word.length <= 75));
  assert.equal(words.map((word) => Buffer.from(word[1]!, "base64").toString("utf8")).join(""), `SSS · ${unicodeEvent.monitorId}`);
  assert.ok(body.includes(event.url!));
  assert.ok(body.includes(String((event.after as { text: string }).text)));
  for (const evidence of [event.reason, "fresh limits tomorrow?", "gpt-6.1-sol", "xhigh", "The joke implies refreshed limits."]) {
    assert.ok(body.includes(evidence), `complete evidence: ${evidence}`);
  }
  const id = /^Message-ID: (.+)$/m.exec(headers)?.[1];
  assert.match(id ?? "", /^<[a-f0-9]{64}@super-smart-scanner\.local>$/);
  await deliver(unicodeEvent, "email:0", JSON.stringify(config));
  assert.equal(/^Message-ID: (.+)$/m.exec(parseMessage(await readFile(capture.message, "utf8")).headers)?.[1], id);
});

test("email leaves sender selection to the msmtp account when from is omitted", async (t) => {
  const capture = await mockMsmtp(t);
  await deliver(event, "email:default", JSON.stringify({ type: "email", to: config.to }));
  const args = JSON.parse(await readFile(capture.args, "utf8")) as string[];
  assert.ok(args.includes("--set-from-header=auto"));
  assert.equal(args.some((arg) => arg.startsWith("--from=") || arg.startsWith("--account=")), false);
  assert.equal(args.at(-1), config.to);
});

test("email rejects recipient, sender, account and subject control injection before spawning", async (t) => {
  const capture = await mockMsmtp(t);
  for (const invalid of [
    { ...config, to: "reader@example.com\r\nBcc: attacker@example.com" },
    { ...config, to: "--debug" },
    { ...config, from: "sender@example.com\u0000" },
    { ...config, account: "gmail\n--debug" },
  ]) await assert.rejects(deliver(event, "email:0", JSON.stringify(invalid)), /invalid email notification/);
  await assert.rejects(deliver({ ...event, monitorId: "watch\r\nBcc: attacker@example.com" }, "email:0", JSON.stringify(config)), /invalid email subject/);
  await assert.rejects(readFile(capture.args), { code: "ENOENT" });
});

test("email failures keep credentials opaque and retry the existing durable delivery", async (t) => {
  const capture = await mockMsmtp(t, "fail");
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.syncMonitor({ id: event.monitorId, name: "Reset", enabled: true }, "{}", event.namespace, event.observedAt);
  const run = store.beginRun(event.monitorId, event.namespace, "due", event.observedAt, "2026-10-06T00:00:00.000Z");
  store.insertEvent({ ...event, runId: run.id }, [{ channel: "email:0", config }]);
  assert.deepEqual(await drainOutbox(store, new Date(event.observedAt)), { sent: 0, failed: 1 });
  const delivery = store.db.prepare("SELECT status, attempts, last_error FROM deliveries").get() as Record<string, unknown>;
  assert.equal(delivery["status"], "failed");
  assert.equal(delivery["attempts"], 1);
  assert.match(String(delivery["last_error"]), /msmtp exited 75/);
  assert.equal(/fixture-secret|credential-value/.test(String(delivery["last_error"])), false);
  await capture.succeed();
  assert.deepEqual(await drainOutbox(store, new Date("2026-10-07T01:02:33.000Z")), { sent: 1, failed: 0 });
  assert.equal(store.db.prepare("SELECT status FROM deliveries").get()?.["status"], "sent");
});

test("email bounds a hung executable within the delivery lease", async (t) => {
  const capture = await mockMsmtp(t, "hang");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(deliver(event, "email:0", JSON.stringify(config)), /email delivery timed out/);
  const deadline = Date.now() + 5_000;
  while (true) {
    try { await readFile(capture.args); break; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      assert.ok(Date.now() < deadline, "mock msmtp starts");
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  t.mock.timers.tick(60_000);
  t.mock.timers.tick(2_000);
  await rejected;
});

test("email timeout terminates a credential helper after the msmtp parent exits on TERM", async (t) => {
  const capture = await mockMsmtp(t, "descendant");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(deliver(event, "email:0", JSON.stringify(config)), /email delivery timed out/);
  const startDeadline = Date.now() + 5_000;
  while (true) {
    try { await readFile(capture.helperPid); break; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      assert.ok(Date.now() < startDeadline, "credential helper starts");
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  t.mock.timers.tick(60_000);
  // Let the TERM-responsive parent close before the escalation timer fires.
  const parentExitWindow = Date.now() + 100;
  while (Date.now() < parentExitWindow) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(2_000);
  await rejected;
  await writeFile(capture.pulse, "check");
  const survivalWindow = Date.now() + 150;
  while (Date.now() < survivalWindow) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(readFile(capture.survived), { code: "ENOENT" });
});
