import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

test("daemon stays resident and exits cleanly on SIGTERM", async (context) => {
  const fixture = await runtimeFixture(context);
  const child = launch(["daemon", "--ephemeral"], fixture);
  context.after(() => stop(child));
  await outputContaining(child, "SSS scheduler running");
  assert.equal(child.exitCode, null);
  child.kill("SIGTERM");
  assert.deepEqual(await exited(child), [0, null]);
});

test("dashboard serves health and closes its listener on SIGTERM", async (context) => {
  const fixture = await runtimeFixture(context);
  const port = await unusedPort();
  const child = launch(["serve", "--ephemeral", "--port", String(port)], fixture);
  context.after(() => stop(child));
  await outputContaining(child, "SSS dashboard");
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 200);
  child.kill("SIGTERM");
  assert.deepEqual(await exited(child), [0, null]);
});

test("new works outside the repository and degraded test exits nonzero", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sss-cli-outside-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const executable = join(root, "src", "cli.ts");
  assert.equal(spawnSync(process.execPath, [executable, "init"], { cwd: directory, encoding: "utf8" }).status, 0);
  assert.equal(spawnSync(process.execPath, [executable, "new", "research", "outside"], { cwd: directory, encoding: "utf8" }).status, 0);
  assert.match(await readFile(join(directory, "monitors", "outside.yaml"), "utf8"), /id: outside/);
  const failedRecipe = join(directory, "monitors", "blocked.yaml");
  await writeFile(failedRecipe, `version: 1
id: blocked
name: Blocked
enabled: false
schedule: { every: 1h }
source:
  type: html
  url: http://127.0.0.1/private
  fields: { heading: { selector: h1 } }
rules: [{ id: changed, type: field_changed, field: heading }]
`);
  const failed = spawnSync(process.execPath, [executable, "test", failedRecipe], { cwd: directory, encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^degraded/);
});

test("serve reports a busy port through the CLI error boundary", async (context) => {
  const fixture = await runtimeFixture(context);
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  context.after(async () => { await new Promise<void>((resolveClose) => blocker.close(() => resolveClose())); });
  const address = blocker.address();
  if (!address || typeof address === "string") throw new Error("test listener has no TCP port");
  const result = spawnSync(process.execPath, ["src/cli.ts", "serve", "--ephemeral", "--port", String(address.port)], {
    cwd: root, env: fixture, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^sss: Error: listen EADDRINUSE/);
  assert.equal(result.stdout.includes("SSS dashboard"), false);
});

async function runtimeFixture(context: { after: (callback: () => Promise<void>) => void }): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "sss-cli-"));
  const monitors = join(directory, "monitors");
  await mkdir(monitors);
  context.after(async () => rm(directory, { recursive: true, force: true }));
  return { ...process.env, SSS_STATE_DIR: join(directory, "state"), SSS_MONITORS_DIR: monitors };
}

function launch(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ["src/cli.ts", ...args], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function outputContaining(child: ChildProcess, text: string): Promise<void> {
  let output = "";
  const wait = new Promise<void>((resolveOutput, rejectOutput) => {
    const inspect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(text)) resolveOutput();
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("exit", (code, signal) => rejectOutput(new Error(`child exited before '${text}' (${code ?? signal}): ${output}`)));
  });
  await withTimeout(wait, 5_000, `timed out waiting for '${text}': ${output}`);
}

async function exited(child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode];
  return withTimeout(once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>, 5_000, "child did not exit");
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); });
  try { return await Promise.race([promise, timeout]); } finally { if (timer) clearTimeout(timer); }
}

function stop(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test listener has no TCP port");
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}
