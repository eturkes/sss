import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { safeRequest } from "../security/network.ts";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const IMAGE_LIMIT = 4 * 1024 * 1024;
const TOTAL_IMAGE_LIMIT = 8 * 1024 * 1024;
const STREAM_LIMIT = 1024 * 1024;

export type InferenceDependencies = {
  authPath?: string;
  fetch?: typeof globalThis.fetch;
  imageRequest?: typeof safeRequest;
};

type Auth = { accessToken: string; accountId: string };
type InferenceInput = { payload: string; instructions: string; schema: Record<string, unknown>; media: string[] };

export async function inferStructured(input: InferenceInput, timeoutMs: number, dependencies: InferenceDependencies = {}): Promise<string> {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const authPath = dependencies.authPath ?? join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json");
  try {
    const images = await acquireImages(input.media, dependencies.imageRequest ?? safeRequest, deadline);
    controller.signal.throwIfAborted();
    let auth = await readAuth(authPath);
    if (expiresSoon(auth.accessToken)) {
      await refreshAuth(controller.signal);
      auth = await readAuth(authPath);
    }
    const body = {
      model: "gpt-6.1-sol", instructions: input.instructions,
      input: [{ role: "user", content: [
        { type: "input_text", text: input.payload },
        ...images.map(image_url => ({ type: "input_image", image_url, detail: "high" })),
      ] }],
      tools: [], tool_choice: "none", parallel_tool_calls: false,
      reasoning: { effort: "xhigh" }, store: false, stream: true,
      text: { format: { type: "json_schema", name: "sss_assessment", strict: true, schema: input.schema } },
    };
    const fetchInference = dependencies.fetch ?? globalThis.fetch;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchInference(ENDPOINT, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${auth.accessToken}`, "chatgpt-account-id": auth.accountId, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
      });
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        await refreshAuth(controller.signal);
        auth = await readAuth(authPath);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`assessment inference failed (HTTP ${response.status})`);
      }
      // The Codex endpoint can omit Content-Type while returning SSE; frame validation remains mandatory.
      const mime = response.headers.get("content-type");
      if (mime !== null && !mime.toLowerCase().startsWith("text/event-stream")) {
        await response.body?.cancel();
        throw new Error("assessment inference returned a non-stream response");
      }
      return await readResult(response, controller.signal);
    }
    throw new Error("assessment inference authentication failed");
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`assessment timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readAuth(path: string): Promise<Auth> {
  try {
    const auth = JSON.parse(await readFile(path, "utf8")) as { auth_mode?: unknown; tokens?: { access_token?: unknown; account_id?: unknown } };
    const accessToken = auth.tokens?.access_token;
    const accountId = auth.tokens?.account_id;
    if (auth.auth_mode !== "chatgpt" || typeof accessToken !== "string" || !accessToken || typeof accountId !== "string" || !accountId) throw new Error();
    return { accessToken, accountId };
  } catch { throw new Error("assessment requires a Codex ChatGPT login; run codex login"); }
}

function expiresSoon(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && payload.exp * 1000 <= Date.now() + 30_000;
  } catch { return false; }
}

function refreshAuth(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Model discovery refreshes CLI-owned OAuth credentials without receiving acquired content or an inference prompt.
    const args = ["debug", "models", "-c", 'model_provider="openai"', "-c", "features.plugins=false", "-c", "features.apps=false", "-c", "features.hooks=false"];
    const keep = ["PATH", "HOME", "CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
    const env = Object.fromEntries(keep.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])) as NodeJS.ProcessEnv;
    const child = spawn("codex", args, { cwd: tmpdir(), detached: true, stdio: "ignore", env });
    let startError = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (kind: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, kind); } catch { child.kill(kind); }
    };
    const abort = () => { kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 250); };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => { startError = true; });
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      kill("SIGKILL");
      if (signal.aborted) reject(new Error("assessment login refresh timed out"));
      else if (startError || code !== 0) reject(new Error("assessment login refresh failed; run codex login"));
      else resolve();
    });
    if (signal.aborted) abort();
  });
}

function mediaUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== "https://pbs.twimg.com" || url.username || url.password || url.hash ||
      !/^\/media\/[A-Za-z0-9_-]+(?:\.(?:jpe?g|png|webp))?$/i.test(url.pathname) ||
      [...url.searchParams.keys()].some(key => !["format", "name"].includes(key)) ||
      (url.searchParams.has("format") && !/^(?:jpe?g|png|webp)$/i.test(url.searchParams.get("format") ?? ""))) {
    throw new Error("assessment media URL is not an allowlisted X image");
  }
  return url.href;
}

async function acquireImages(media: string[], request: typeof safeRequest, deadline: number): Promise<string[]> {
  if (media.length > 4) throw new Error("assessment media exceeds four images");
  const urls = media.map(mediaUrl);
  const images: string[] = [];
  let total = 0;
  for (const url of urls) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("assessment media acquisition timed out");
    const response = await request(url, { maxBodyBytes: IMAGE_LIMIT, maxRedirects: 0, timeoutMs: Math.min(30_000, remaining), headers: { accept: "image/jpeg, image/png, image/webp" } });
    const type = response.headers["content-type"];
    const mime = typeof type === "string" ? type.split(";")[0]?.trim().toLowerCase() : undefined;
    const bytes = Buffer.from(response.body);
    const magic = mime === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) :
      mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
      mime === "image/webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    total += bytes.length;
    if (response.status !== 200 || !magic || bytes.length > IMAGE_LIMIT || total > TOTAL_IMAGE_LIMIT) throw new Error("assessment media response is invalid or too large");
    images.push(`data:${mime};base64,${bytes.toString("base64")}`);
  }
  return images;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("assessment inference output is malformed");
  return value as Record<string, unknown>;
}

function completedOutput(value: unknown, finishedItems: unknown[]): string {
  const response = record(value);
  if (response["status"] !== "completed" || !Array.isArray(response["output"])) throw new Error("assessment inference output is incomplete");
  const aggregate = response["output"];
  // Some Codex streams omit the final aggregate text. Only finalized items can fill that omission, never deltas.
  const output = aggregate.some(raw => record(raw)["type"] === "message") ? aggregate : [...aggregate, ...finishedItems];
  const messages: Record<string, unknown>[] = [];
  for (const raw of output) {
    const item = record(raw);
    if (item["type"] === "reasoning") continue;
    if (item["type"] !== "message" || item["role"] !== "assistant" || !Array.isArray(item["content"])) throw new Error("assessment inference returned forbidden output");
    if (item["status"] !== undefined && item["status"] !== "completed") throw new Error("assessment inference output is incomplete");
    messages.push(item);
  }
  const finals = messages.filter(item => item["phase"] === "final_answer");
  const selected = finals.length === 1 && messages.every(item => ["final_answer", "commentary"].includes(String(item["phase"]))) ? finals[0] :
    messages.length === 1 && messages[0]?.["phase"] === undefined ? messages[0] : undefined;
  const texts: string[] = [];
  for (const item of messages) {
    for (const rawContent of item["content"] as unknown[]) {
      const content = record(rawContent);
      if (content["type"] !== "output_text" || typeof content["text"] !== "string") throw new Error("assessment inference output is not text");
      if (item === selected) texts.push(content["text"]);
    }
  }
  const text = texts.join("");
  if (!selected || !text || Buffer.byteLength(text) > 65_536) throw new Error(`assessment inference output is missing or too large (${messages.length} messages, ${Buffer.byteLength(text)} bytes)`);
  return text;
}

async function readResult(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new Error("assessment inference output is missing");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let bytes = 0;
  const finishedItems: unknown[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > STREAM_LIMIT) throw new Error("assessment inference stream is too large");
      pending = (pending + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
      let separator: number;
      while ((separator = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, separator);
        pending = pending.slice(separator + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        let event: Record<string, unknown>;
        try { event = record(JSON.parse(data) as unknown); }
        catch { throw new Error("assessment inference output stream is malformed"); }
        const type = event["type"];
        if (type === "response.completed") return completedOutput(event["response"], finishedItems);
        if (type === "error" || type === "response.failed" || type === "response.incomplete") throw new Error("assessment inference failed before completion");
        if (typeof type !== "string" || /(?:function_call|custom_tool_call|tool_call)/.test(type)) throw new Error("assessment inference returned forbidden output");
        if ((type === "response.output_item.added" || type === "response.output_item.done") && !["message", "reasoning"].includes(String(record(event["item"])["type"]))) throw new Error("assessment inference returned forbidden output");
        if (type === "response.output_item.done") finishedItems.push(event["item"]);
      }
    }
    throw new Error("assessment inference output stream ended before completion");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
