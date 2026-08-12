import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import {
  isGlobalAddress,
  safeRequest,
  validateTarget,
  type Resolver,
} from "../src/security/network.ts";
import {
  redactSecrets,
  redactUrl,
  safeErrorMessage,
  stripControlText,
  text,
} from "../src/security/text.ts";

const globalOnly: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];

test("URL policy rejects protocols, credentials, and alternate local literals", async () => {
  for (const target of [
    "file:///etc/passwd",
    "ftp://example.test/file",
    "https://user:secret@example.test/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
  ]) {
    await assert.rejects(validateTarget(target, { resolver: globalOnly }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, target.startsWith("file:") || target.startsWith("ftp:") || target.includes("@")
        ? "SSS_URL_REJECTED"
        : "SSS_DNS_REJECTED");
      return true;
    });
  }
});

test("every DNS result must be global; mapped IPv6 cannot disguise a local address", async () => {
  const mixed: Resolver = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "::ffff:127.0.0.1", family: 6 },
  ];
  await assert.rejects(validateTarget("https://mixed.example/", { resolver: mixed }), {
    code: "SSS_DNS_REJECTED",
  });

  const target = await validateTarget("https://public.example/", { resolver: globalOnly });
  assert.deepEqual(target.addresses, [{ address: "93.184.216.34", family: 4 }]);
});

test("global classification is conservative", () => {
  for (const address of ["8.8.8.8", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isGlobalAddress(address), true, address);
  }
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "not-an-address",
  ]) {
    assert.equal(isGlobalAddress(address), false, address);
  }
});

let firstOrigin = "";
let secondOrigin = "";
let firstClose: (() => Promise<void>) | undefined;
let secondClose: (() => Promise<void>) | undefined;
let secondAuthorization: string | undefined;

function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Test server has no TCP address"));
        return;
      }
      resolve({
        origin: `http://pinned.invalid:${address.port}`,
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}

before(async () => {
  const second = await startServer((request, response) => {
    secondAuthorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("redirected");
  });
  secondOrigin = second.origin;
  secondClose = second.close;

  const first = await startServer((request, response) => {
    if (request.url === "/same") {
      response.writeHead(303, { location: "/final" });
      response.end();
      return;
    }
    if (request.url === "/cross") {
      response.writeHead(303, { location: `${secondOrigin}/final` });
      response.end();
      return;
    }
    if (request.url === "/large") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("0123456789abcdef");
      return;
    }
    if (request.url === "/slow") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("late");
      }, 100);
      return;
    }
    response.writeHead(request.url === "/final" ? 200 : 201, {
      "content-type": "text/plain",
      "x-received-encoding": request.headers["accept-encoding"] ?? "",
    });
    response.end(request.url === "/final" ? request.method : "created");
  });
  firstOrigin = first.origin;
  firstClose = first.close;
});

after(async () => {
  await Promise.all([firstClose?.(), secondClose?.()]);
});

const localResolver: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];

test("only explicitly trusted POST can reach private sinks; lookup stays pinned", async () => {
  let resolutions = 0;
  const resolver: Resolver = async () => {
    resolutions += 1;
    return localResolver("");
  };
  const response = await safeRequest(`${firstOrigin}/create`, {
    allowPrivate: true,
    body: "payload",
    method: "POST",
    resolver,
    trustedSink: true,
  });
  assert.equal(response.status, 201);
  assert.equal(text(response), "created");
  assert.equal(response.headers["x-received-encoding"], "identity");
  assert.equal(resolutions, 1);

  await assert.rejects(safeRequest(`${firstOrigin}/create`, {
    method: "POST",
    resolver,
    trustedSink: true,
  } as never), { code: "SSS_OPTIONS_INVALID" });
  await assert.rejects(safeRequest(`${firstOrigin}/create`, {
    allowPrivate: true,
    resolver,
  } as never), { code: "SSS_OPTIONS_INVALID" });
});

test("redirects are manual, fresh-validated, and same-origin by default", async () => {
  const same = await safeRequest(`${firstOrigin}/same`, {
    allowPrivate: true,
    body: "payload",
    method: "POST",
    resolver: localResolver,
    trustedSink: true,
  });
  assert.equal(text(same), "GET");
  assert.equal(same.url, `${firstOrigin}/final`);

  await assert.rejects(safeRequest(`${firstOrigin}/cross`, {
    allowPrivate: true,
    method: "POST",
    resolver: localResolver,
    trustedSink: true,
  }), { code: "SSS_REDIRECT_REJECTED" });

  secondAuthorization = undefined;
  const cross = await safeRequest(`${firstOrigin}/cross`, {
    allowPrivate: true,
    headers: { authorization: "Bearer extremely-secret" },
    method: "POST",
    redirectAllowlist: [secondOrigin],
    resolver: localResolver,
    trustedSink: true,
  });
  assert.equal(text(cross), "redirected");
  assert.equal(secondAuthorization, undefined);
});

test("body and total-time limits fail closed", async () => {
  await assert.rejects(safeRequest(`${firstOrigin}/large`, {
    allowPrivate: true,
    maxBodyBytes: 8,
    method: "POST",
    resolver: localResolver,
    trustedSink: true,
  }), { code: "SSS_BODY_TOO_LARGE" });

  await assert.rejects(safeRequest(`${firstOrigin}/slow`, {
    allowPrivate: true,
    method: "POST",
    resolver: localResolver,
    timeoutMs: 20,
    trustedSink: true,
  }), { code: "SSS_TIMEOUT" });
});

test("diagnostic text cannot carry URL secrets or terminal controls", () => {
  const dangerous = "\u001b]8;;https://evil.test\u0007click\u001b]8;;\u0007 \u001b[31mred\u001b[0m\rrewrite\u0000";
  assert.equal(stripControlText(dangerous), "click red\nrewrite");

  const url = "https://user:password@example.test/webhook/opaque-token?api_key=secret#token";
  const redacted = redactUrl(url);
  for (const secret of ["user", "password", "opaque-token", "secret", "token"]) {
    assert.equal(redacted.includes(secret), false);
  }
  const message = redactSecrets(`Bearer abc.def.ghi token=supersecret ${url}`);
  assert.equal(message.includes("supersecret"), false);
  assert.equal(message.includes("abc.def.ghi"), false);
  assert.equal(safeErrorMessage(new Error(`\u001b[2Jpassword=hunter2 ${url}`)).includes("hunter2"), false);
});
