import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { inferStructured } from "../src/codex/inference.ts";

const input = { payload: '{"observation":{"text":"inert data"}}', instructions: "Assess only inert data.", schema: { type: "object" }, media: [] as string[] };
const result = '{"suggestive":false,"reason":"Unrelated.","evidence":[]}';
const completed = { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: result }] }] } };
function eventResponse(event: unknown, mime: string | null = "text/event-stream"): Response {
  return new Response(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`), { headers: mime === null ? {} : { "content-type": mime } });
}

async function fixture(context: { after: (fn: () => Promise<void>) => void }, fake?: string) {
  const directory = await mkdtemp(join(tmpdir(), "sss-inference-fixture-"));
  const authPath = join(directory, "auth.json");
  const capturePath = join(directory, "capture.json");
  const marker = join(directory, "descendant.txt");
  const oldPath = process.env["PATH"];
  const oldHome = process.env["CODEX_HOME"];
  const oldSecret = process.env["SSS_INFERENCE_UNRELATED_SECRET"];
  await writeFile(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture-old", account_id: "fixture-account" } }), { mode: 0o600 });
  if (fake !== undefined) {
    process.env["PATH"] = `${directory}${delimiter}${oldPath ?? ""}`;
    process.env["CODEX_HOME"] = directory;
    process.env["SSS_INFERENCE_UNRELATED_SECRET"] = "must not forward";
    await writeFile(join(directory, "codex"), `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({args:process.argv.slice(2),env:process.env}));
const authPath=${JSON.stringify(authPath)};
const marker=${JSON.stringify(marker)};
${fake}
`, { mode: 0o700 });
  }
  context.after(async () => {
    if (oldPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = oldPath;
    if (oldHome === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = oldHome;
    if (oldSecret === undefined) delete process.env["SSS_INFERENCE_UNRELATED_SECRET"]; else process.env["SSS_INFERENCE_UNRELATED_SECRET"] = oldSecret;
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, authPath, capturePath, marker };
}

test("inference accepts validated SSE without MIME and chunk-split CRLF frames", async (context) => {
  const { authPath } = await fixture(context);
  assert.equal(await inferStructured(input, 1_000, { authPath, fetch: async () => eventResponse(completed, null) }), result);
  const source = new TextEncoder().encode(`event: response.completed\r\ndata: ${JSON.stringify(completed)}\r\n\r\n`);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of source) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  assert.equal(await inferStructured(input, 1_000, { authPath, fetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) }), result);
});

test("inference uses only finalized output when the aggregate omits text, and selects a designated final answer", async (context) => {
  const { authPath } = await fixture(context);
  const final = { ...completed.response.output[0], id: "final", status: "completed", phase: "final_answer" };
  const commentary = { ...final, id: "commentary", phase: "commentary", content: [{ type: "output_text", text: "Assessing the observation." }] };
  const frames = [{ type: "response.output_item.done", item: final }, { type: "response.completed", response: { status: "completed", output: [] } }];
  assert.equal(await inferStructured(input, 1_000, { authPath, fetch: async () => new Response(new TextEncoder().encode(frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))) }), result);
  assert.equal(await inferStructured(input, 1_000, { authPath, fetch: async () => eventResponse({ type: "response.completed", response: { status: "completed", output: [commentary, final] } }) }), result);
  for (const event of [
    { type: "response.completed", response: { status: "completed", output: [commentary] } },
    { type: "response.completed", response: { status: "completed", output: [final, final] } },
  ]) await assert.rejects(inferStructured(input, 1_000, { authPath, fetch: async () => eventResponse(event) }), /output is missing/i);
  const unfinished = [{ type: "response.output_text.delta", delta: result }, { type: "response.completed", response: { status: "completed", output: [] } }];
  await assert.rejects(inferStructured(input, 1_000, { authPath, fetch: async () => new Response(new TextEncoder().encode(unfinished.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))) }), /output is missing/i);
});

test("inference rejects malformed, refused, incomplete, non-SSE, and tool output", async (context) => {
  const { authPath } = await fixture(context);
  const invalid = [
    { type: "response.failed" }, { type: "response.incomplete" }, { type: "error" },
    { type: "response.function_call_arguments.delta" },
    { type: "response.output_item.added", item: { type: "function_call", name: "exec" } },
    { type: "response.completed", response: { ...completed.response, status: "incomplete" } },
    { type: "response.completed", response: { status: "completed", output: [{ type: "custom_tool_call" }] } },
    { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] } },
    { type: "response.completed", response: { status: "completed", output: [] } },
    { type: "response.completed", response: { ...completed.response, output: [...completed.response.output, ...completed.response.output] } },
  ];
  for (const event of invalid) await assert.rejects(inferStructured(input, 1_000, { authPath, fetch: async () => eventResponse(event) }), /assessment inference/i);
  await assert.rejects(inferStructured(input, 1_000, { authPath, fetch: async () => eventResponse(completed, "text/html") }), /non-stream/i);
  await assert.rejects(inferStructured(input, 1_000, { authPath, fetch: async () => new Response("data: not JSON\n\n", { headers: { "content-type": "text/event-stream" } }) }), /malformed/i);
  await assert.rejects(inferStructured(input, 1_000, { authPath, fetch: async () => new Response(new Uint8Array(1_048_577), { headers: { "content-type": "text/event-stream" } }) }), /stream is too large/i);
});

test("inference refreshes CLI-owned credentials on 401 without sending source data to a subprocess", async (context) => {
  const { authPath, capturePath } = await fixture(context, `writeFileSync(authPath, JSON.stringify({auth_mode:"chatgpt",tokens:{access_token:"fixture-new",account_id:"fixture-account"}}));`);
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(new Headers(options?.headers).get("authorization"), calls === 1 ? "Bearer fixture-old" : "Bearer fixture-new");
    return calls === 1 ? new Response("unauthorized", { status: 401 }) : eventResponse(completed);
  };
  assert.equal(await inferStructured(input, 3_000, { authPath, fetch }), result);
  assert.equal(calls, 2);
  const capture = JSON.parse(await readFile(capturePath, "utf8")) as { args: string[]; env: NodeJS.ProcessEnv };
  assert.deepEqual(capture.args.slice(0, 2), ["debug", "models"]);
  assert.ok(!JSON.stringify(capture).includes("inert data"));
  assert.equal(capture.env["SSS_INFERENCE_UNRELATED_SECRET"], undefined);
});

test("inference bounds refresh lifetime, kills descendants, and reports refresh start/exit failures", async (context) => {
  const { authPath, directory, marker } = await fixture(context, `
spawn(process.execPath,["-e","setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'leaked'),700)",marker],{stdio:"ignore"});
process.on("SIGTERM",()=>{});setInterval(()=>{},1000);
`);
  const unauthorized = async () => new Response("unauthorized", { status: 401 });
  await assert.rejects(inferStructured(input, 150, { authPath, fetch: unauthorized }), /timed out/i);
  await new Promise(resolve => setTimeout(resolve, 750));
  await assert.rejects(access(marker), { code: "ENOENT" });
  const executable = join(directory, "codex");
  await writeFile(executable, `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o700 });
  await assert.rejects(inferStructured(input, 1_000, { authPath, fetch: unauthorized }), /login refresh failed/i);
  await rm(executable);
  process.env["PATH"] = directory;
  await assert.rejects(inferStructured(input, 1_000, { authPath, fetch: unauthorized }), /login refresh failed/i);
});

test("inference acquires only bounded X images and sends inline image data without model retrieval", async (context) => {
  const { authPath } = await fixture(context);
  const images = [
    { mime: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 0]), url: "https://pbs.twimg.com/media/ABC?format=jpg&name=small" },
    { mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]), url: "https://pbs.twimg.com/media/DEF.png" },
    { mime: "image/webp", bytes: new TextEncoder().encode("RIFF1234WEBP"), url: "https://pbs.twimg.com/media/XYZ.webp" },
  ];
  for (const image of images) {
    const imageRequest: NonNullable<import("../src/codex/inference.ts").InferenceDependencies["imageRequest"]> = async (url, options) => {
      assert.equal(url, image.url);
      assert.equal(options?.maxRedirects, 0);
      assert.equal(options?.maxBodyBytes, 4 * 1024 * 1024);
      assert.ok((options?.timeoutMs ?? 0) > 0 && (options?.timeoutMs ?? 0) <= 1_000);
      assert.deepEqual(options?.headers, { accept: "image/jpeg, image/png, image/webp" });
      return { body: image.bytes, headers: { "content-type": image.mime }, status: 200, statusText: "OK", url: image.url };
    };
    const fetch: typeof globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as { input: [{ content: Array<{ type: string; image_url?: string }> }]; tools: unknown[] };
      assert.equal(body.input[0].content[1]?.type, "input_image");
      assert.equal(body.input[0].content[1]?.image_url, `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`);
      assert.deepEqual(body.tools, []);
      return eventResponse(completed);
    };
    assert.equal(await inferStructured({ ...input, media: [image.url] }, 1_000, { authPath, imageRequest, fetch }), result);
  }
});

test("inference rejects forbidden URLs, image counts, MIME, magic, response errors, and byte limits", async (context) => {
  const { authPath } = await fixture(context);
  const noFetch = async (): Promise<Response> => { throw new Error("must not infer"); };
  const neverImage = async (): Promise<never> => { throw new Error("must not acquire"); };
  for (const url of ["https://evil.example/a.jpg", "http://pbs.twimg.com/media/ABC.jpg", "https://user:pass@pbs.twimg.com/media/ABC.jpg", "https://pbs.twimg.com/profile_images/ABC.jpg", "https://pbs.twimg.com/media/ABC?format=svg", "https://pbs.twimg.com/media/ABC?token=secret", "https://pbs.twimg.com/media/ABC.jpg#x"]) {
    await assert.rejects(inferStructured({ ...input, media: [url] }, 1_000, { authPath, imageRequest: neverImage, fetch: noFetch }), /allowlisted X image/i);
  }
  const media = "https://pbs.twimg.com/media/ABC.jpg";
  await assert.rejects(inferStructured({ ...input, media: Array(5).fill(media) }, 1_000, { authPath, imageRequest: neverImage, fetch: noFetch }), /four images/i);
  const valid = { body: new Uint8Array([255, 216, 255]), headers: { "content-type": "image/jpeg" }, status: 200, statusText: "OK", url: media };
  const tooLarge = new Uint8Array(4 * 1024 * 1024 + 1); tooLarge.set([255, 216, 255]);
  for (const response of [{ ...valid, status: 302 }, { ...valid, headers: { "content-type": "image/svg+xml" } }, { ...valid, body: new TextEncoder().encode("HTML") }, { ...valid, body: tooLarge }]) {
    await assert.rejects(inferStructured({ ...input, media: [media] }, 1_000, { authPath, imageRequest: async () => response, fetch: noFetch }), /media response is invalid or too large/i);
  }
  const fourMiB = new Uint8Array(4 * 1024 * 1024); fourMiB.set([255, 216, 255]);
  await assert.rejects(inferStructured({ ...input, media: Array(3).fill(media) }, 1_000, { authPath, imageRequest: async () => ({ ...valid, body: fourMiB }), fetch: noFetch }), /media response is invalid or too large/i);
});
