import { randomBytes, timingSafeEqual } from "node:crypto";
import { html, raw } from "hono/html";
import { Hono, type Context } from "hono";
import { MAX_RECIPE_BYTES, parseMonitor, parseMonitorSource, type EditableRecipe } from "../config/load.ts";
import type { Monitor, NtfyNotification } from "../config/schema.ts";
import type { ChangeEvent, MonitorStatus } from "../core/types.ts";
import { safeErrorMessage } from "../security/text.ts";
import { Store, type DeliveryHealth } from "../store/database.ts";

export type DashboardActions = {
  run: (id: string) => Promise<unknown>;
  sync: () => Promise<unknown>;
  recipe?: (id: string) => Promise<EditableRecipe | undefined>;
  saveRecipe?: (id: string, source: string, revision: string) => Promise<unknown>;
};

export function createApp(store: Store, actions: DashboardActions, options: { port?: number; token?: string } = {}): Hono {
  const app = new Hono();
  const port = options.port ?? 7337;
  const token = options.token ?? randomBytes(24).toString("base64url");
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

  app.use("*", async (context, next) => {
    const host = context.req.header("host") ?? "";
    if (!allowedHosts.has(host)) return context.text("invalid host", 403);
    const origin = context.req.header("origin");
    if (origin) {
      let normalizedOrigin = "";
      try { normalizedOrigin = new URL(origin).origin; } catch { return context.text("invalid origin", 403); }
      if (!allowedOrigins.has(normalizedOrigin)) return context.text("invalid origin", 403);
    }
    await next();
    context.header("Content-Security-Policy", "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Cache-Control", "no-store");
  });

  app.get("/style.css", (context) => context.body(STYLE, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" }));
  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/api/status", (context) => context.json(store.status()));
  app.get("/api/events", (context) => context.json(store.events(clampedLimit(context.req.query("limit")))));
  app.get("/api/runs", (context) => context.json(store.recentRuns(clampedLimit(context.req.query("limit")))));
  app.get("/api/deliveries", (context) => context.json({ health: store.deliveryHealth(), rows: store.failedDeliveries(clampedLimit(context.req.query("limit"))) }));
  app.get("/api/observations/:monitor", (context) => context.json(store.observations(context.req.param("monitor"), context.req.query("item"), clampedLimit(context.req.query("limit")))));

  app.get("/", (context) => context.html(page(store.status(), store.events(40), store.deliveryHealth(), token, !!actions.recipe && !!actions.saveRecipe)));
  app.get("/notifications", (context) => context.html(notificationPage(configuredMonitors(store))));
  app.get("/recipes/:id", async (context) => {
    if (!actions.recipe || !actions.saveRecipe) return context.notFound();
    try {
      const recipe = await actions.recipe(context.req.param("id"));
      if (!recipe) return context.notFound();
      return context.html(editorPage(recipe, token, undefined, context.req.query("saved") === "1"));
    } catch (error) { return context.text(safeErrorMessage(error, 2_000), 409); }
  });
  app.post("/recipes/:id", async (context) => {
    const body = await readPost(context, MAX_RECIPE_BYTES * 3 + 8_192);
    if (body instanceof Response) return body;
    if (!tokenEquals(body.get("csrf"), token)) return context.text("invalid CSRF token", 403);
    if (!actions.recipe || !actions.saveRecipe) return context.notFound();
    const source = body.get("source");
    const revision = body.get("revision");
    if (source !== null && Buffer.byteLength(source) > MAX_RECIPE_BYTES) return context.text("recipe is too large", 413);
    if (source === null || !revision || revision.length > 256) return context.text("source and revision are required", 400);
    let recipe: EditableRecipe;
    try {
      const current = await actions.recipe(context.req.param("id"));
      if (!current) return context.notFound();
      recipe = { ...current, source, revision };
    } catch (error) { return context.text(safeErrorMessage(error, 2_000), 409); }
    try {
      const config = parseMonitorSource(source);
      if (config.id !== context.req.param("id")) throw new Error("The monitor ID cannot change. Keep the existing ID.");
    } catch (error) {
      return context.html(editorPage(recipe, token, safeErrorMessage(error, 8_000)), 422);
    }
    try {
      await actions.saveRecipe(context.req.param("id"), source, revision);
      return context.redirect(`/recipes/${encodeURIComponent(context.req.param("id"))}?saved=1`, 303);
    } catch (error) {
      return context.html(editorPage(recipe, token, safeErrorMessage(error, 2_000)), 409);
    }
  });
  app.post("/run/:id", async (context) => {
    const body = await readPost(context, 8_192);
    if (body instanceof Response) return body;
    if (!tokenEquals(body.get("csrf"), token)) return context.text("invalid CSRF token", 403);
    await actions.run(context.req.param("id"));
    return context.redirect("/", 303);
  });
  app.post("/sync", async (context) => {
    const body = await readPost(context, 8_192);
    if (body instanceof Response) return body;
    if (!tokenEquals(body.get("csrf"), token)) return context.text("invalid CSRF token", 403);
    await actions.sync();
    return context.redirect("/", 303);
  });
  return app;
}

async function readPost(context: Context, limit: number): Promise<URLSearchParams | Response> {
  const length = context.req.header("content-length");
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) return context.text("request body too large", 413);
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(context.req.header("content-type") ?? "")) return context.text("use a form-encoded request", 415);
  const reader = context.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) { await reader.cancel(); return context.text("request body too large", 413); }
        chunks.push(value);
      }
    }
    const form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    const fields = new Set<string>();
    for (const key of form.keys()) {
      if (fields.has(key)) return context.text("duplicate form fields", 400);
      fields.add(key);
    }
    return form;
  } catch { return context.text("invalid request body", 400); }
  finally { reader?.releaseLock(); }
}

function tokenEquals(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function clampedLimit(rawValue: string | undefined): number {
  const parsed = Number(rawValue ?? 100);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(parsed, 500)) : 100;
}

function page(monitors: MonitorStatus[], events: ChangeEvent[], delivery: DeliveryHealth, token: string, canEdit: boolean) {
  const degraded = monitors.filter((monitor) => monitor.errorStreak > 0).length + delivery.failed;
  const active = monitors.filter((monitor) => monitor.enabled).length;
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>SSS — Monitor dashboard</title><link rel="stylesheet" href="/style.css">
      </head>
      <body>
        <header>
          <div class="mark"><span class="pulse"></span><b>SSS</b><small>SUPER SMART SCANNER</small></div>
          <nav><a href="/notifications">Mobile alerts</a><form method="post" action="/sync"><input type="hidden" name="csrf" value=${token}><button>SYNC RECIPES</button></form></nav>
        </header>
        <main>
          <section class="hero">
            <div><p class="eyebrow">LOCAL OBSERVATION DECK</p><h1>Watch the web.<br><em>Keep the evidence.</em></h1></div>
            <div class="telemetry"><dl><div><dt>ACTIVE</dt><dd>${active}</dd></div><div><dt>DEGRADED</dt><dd class=${degraded ? "warn" : ""}>${degraded}</dd></div><div><dt>RECENT EVENTS</dt><dd>${events.length}</dd></div></dl><p>SSS captures sources, stores durable history, and alerts on state transitions.${delivery.failed ? ` ${delivery.failed} alert ${delivery.failed === 1 ? "delivery has" : "deliveries have"} failed.` : ""}</p></div>
          </section>
          <section><div class="section-head"><h2>MONITORS</h2><span>${monitors.length} configured</span></div>
            <div class="scanner-grid">${monitors.length ? monitors.map((monitor) => monitorCard(monitor, token, canEdit)) : html`<div class="empty">No monitors exist yet. Run <code>sss new research papers</code> to create a recipe.</div>`}</div>
          </section>
          <section><div class="section-head"><h2>EVENT LOG</h2><span>new and changed items</span></div>
            <div class="events">${events.length ? events.map(eventRow) : html`<div class="empty">No events exist yet.</div>`}</div>
          </section>
        </main>
        <footer><span>127.0.0.1 · PRIVATE BY DEFAULT</span><span>SSS / v0.1</span></footer>
      </body>
    </html>`;
}

function monitorCard(monitor: MonitorStatus, token: string, canEdit: boolean) {
  const state = !monitor.enabled ? "PAUSED" : monitor.errorStreak ? "DEGRADED" : monitor.lastSuccessAt ? "WATCHING" : "UNPRIMED";
  return html`<article class="scanner ${monitor.errorStreak ? "degraded" : ""}">
    <div class="scanner-top"><span class="state">${state}</span><span class="hash">${monitor.namespace.slice(0, 8)}</span></div>
    <h3>${monitor.name}</h3><code>${monitor.id}</code>
    <dl class="facts"><div><dt>LAST SUCCESS</dt><dd>${relative(monitor.lastSuccessAt)}</dd></div><div><dt>NEXT RUN</dt><dd>${monitor.enabled ? relative(monitor.nextDueAt) : "—"}</dd></div></dl>
    ${monitor.lastError ? html`<p class="error">${monitor.lastError}</p>` : ""}
    <div class="card-actions">${canEdit ? html`<a class="button" href="${`/recipes/${encodeURIComponent(monitor.id)}`}">Edit recipe</a>` : ""}<form method="post" action=${`/run/${encodeURIComponent(monitor.id)}`}><input type="hidden" name="csrf" value=${token}><button>RUN NOW <span>↗</span></button></form></div>
  </article>`;
}

function documentPage(title: string, content: ReturnType<typeof html>) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — SSS</title><link rel="stylesheet" href="/style.css"></head><body>
    <header><a class="mark home-link" href="/"><span class="pulse"></span><b>SSS</b><small>SUPER SMART SCANNER</small></a><nav><a href="/">Dashboard</a><a href="/notifications">Mobile alerts</a></nav></header>
    <main class="detail"><p class="eyebrow">LOCAL OBSERVATION DECK</p><h1 class="detail-title">${title}</h1>${content}</main>
    <footer><span>127.0.0.1 · PRIVATE BY DEFAULT</span><span>SSS / v0.1</span></footer></body></html>`;
}

function editorPage(recipe: EditableRecipe, token: string, error?: string, saved = false) {
  return documentPage("Edit recipe", html`
    <div class="section-head"><h2>${recipe.config.name}</h2><code>${recipe.config.id}</code></div>
    <p class="help">Edit the YAML for this monitor. Save validates the recipe and applies it without a scan. Keep the monitor ID. Keep credentials in environment references.</p>
    <p class="help">Source, rule, and assertion changes can establish a new baseline. Schedule and notification changes keep the accepted observations.</p>
    ${saved ? html`<p class="notice" role="status">Recipe saved. The save did not start a scan or send a test notification.</p>` : ""}
    ${error ? html`<div class="notice failure" role="alert"><h2>The recipe was not saved.</h2><pre>${error}</pre><p>Keep a copy of your edits. If the recipe changed or a scan is active, <a href=${`/recipes/${encodeURIComponent(recipe.config.id)}`}>Reload the current recipe</a> and try again.</p></div>` : ""}
    <form class="editor" method="post" action=${`/recipes/${encodeURIComponent(recipe.config.id)}`}>
      <input type="hidden" name="csrf" value="${token}"><input type="hidden" name="revision" value="${recipe.revision}">
      <label for="recipe-source">Recipe YAML</label><textarea id="recipe-source" name="source" rows="30" spellcheck="false" autocapitalize="off" autocomplete="off" required>${recipe.source}</textarea>
      <div class="editor-actions"><button>Save recipe</button><a href="/">Return to dashboard</a></div>
    </form>
    <section class="setup"><div class="section-head"><h2>MOBILE ALERTS</h2><a href="/notifications">Open setup guide ↗</a></div>${ntfyCards([recipe.config])}</section>
  `);
}

function configuredMonitors(store: Store): Monitor[] {
  return store.status().flatMap(monitor => {
    try {
      const stored = store.monitor(monitor.id);
      return stored ? [parseMonitor(JSON.parse(stored.configJson) as unknown)] : [];
    } catch { return []; }
  });
}

function notificationPage(monitors: Monitor[]) {
  return documentPage("Mobile alerts", html`
    <p class="help">Use ntfy to receive monitor events on your phone. No test notification is sent from this page.</p>
    <ol class="setup-steps"><li>Install the ntfy app on your phone.</li><li>Add a subscription. Enter the server and topic shown below.</li><li>If the server requires authentication, add an account with read access in the app.</li><li>Allow notifications for the app in your phone settings.</li></ol>
    <p class="help"><a href="https://docs.ntfy.sh/subscribe/phone/" target="_blank" rel="noopener noreferrer">Open the official ntfy phone setup guide ↗</a></p>
    <p class="help">A subscription link opens the topic in a browser. It does not save a recipe or send a message. The link never contains your token.</p>
    <section><div class="section-head"><h2>CONFIGURED TOPICS</h2><span>${monitors.length} monitors</span></div>${ntfyCards(monitors)}</section>
    <section class="setup"><div class="section-head"><h2>ADD A CHANNEL</h2></div><p class="help">Open a monitor's recipe editor. Add an ntfy channel under <code>notifications</code>. Keep the existing channels that you need.</p>
    <pre class="example">${`notifications:
  - type: inbox
  - type: ntfy
    url: https://ntfy.sh
    topic: choose-a-private-topic
    token: { env: NTFY_TOKEN }`}</pre>
    <p class="help">Set <code>NTFY_TOKEN</code> in the SSS service environment before you enable a channel that needs it. Use your server's access controls to restrict publishing and reading. A hard-to-guess topic is not an access policy.</p>
    <p class="help">Save the recipe after you set the server and topic. Subscribe to the same server and topic on your phone. SSS sends the next matching event through each enabled channel.</p></section>
  `);
}

function ntfyCards(monitors: Monitor[]) {
  const channels = monitors.flatMap(monitor => (monitor.notifications ?? []).flatMap(notification => notification.type === "ntfy" ? [{ monitor, notification }] : []));
  return html`<div class="notification-grid">${channels.length ? channels.map(({ monitor, notification }) => ntfyCard(monitor, notification)) : html`<div class="empty">No ntfy channel is configured. Add a channel in a monitor's recipe editor.</div>`}</div>`;
}

function ntfyCard(monitor: Monitor, notification: NtfyNotification) {
  const server = notification.url ?? notification.server ?? "https://ntfy.sh";
  const subscription = safeHref(`${server.replace(/\/$/, "")}/${encodeURIComponent(notification.topic)}`);
  const serverUrl = new URL(server);
  const android = serverUrl.pathname === "/" && !serverUrl.search && !serverUrl.hash
    ? `ntfy://${serverUrl.host}/${encodeURIComponent(notification.topic)}${serverUrl.protocol === "http:" ? "?secure=false" : ""}` : undefined;
  const references = [...new Set([
    ...(notification.token ? [notification.token.env] : []),
    ...Object.values(notification.headerEnv ?? {}),
    ...Object.values(notification.headers ?? {}).flatMap(value => typeof value === "string" ? [] : [value.env]),
  ])];
  return html`<article class="notification-card"><div class="scanner-top"><span class="state">${monitor.enabled && notification.enabled !== false ? "ENABLED" : "PAUSED"}</span><code>${monitor.id}</code></div>
    <h3>${monitor.name}</h3><dl class="connection"><div><dt>SERVER</dt><dd>${server}</dd></div><div><dt>TOPIC</dt><dd>${notification.topic}</dd></div></dl>
    ${references.length ? html`<p class="help">SSS credential references: ${references.map(name => html`<code>${name}</code> `)}. Configure a read-access credential separately in the ntfy app.</p>` : ""}
    <div class="editor-actions">${subscription ? html`<a class="button" href=${subscription} target="_blank" rel="noopener noreferrer">Open subscription ↗</a>` : ""}${android ? html`<a class="button" href=${android}>Subscribe in Android app ↗</a>` : ""}</div>
  </article>`;
}

function eventRow(event: ChangeEvent) {
  const href = safeHref(event.url);
  return html`<article class="event"><time datetime=${event.observedAt}>${new Date(event.observedAt).toLocaleString()}</time><span class="event-kind">${event.monitorId} · ${event.kind.replaceAll("_", " ")}</span><div><h3>${event.title ?? event.itemId}</h3><p>${event.reason}</p></div>${href ? html`<a href=${href} target="_blank" rel="noopener noreferrer">OPEN ↗</a>` : ""}</article>`;
}

function safeHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}

function relative(value: string | null): string {
  if (!value) return "—";
  const delta = new Date(value).getTime() - Date.now();
  const absolute = Math.abs(delta);
  const [size, unit] = absolute < 60_000 ? [Math.round(absolute / 1_000), "s"] : absolute < 3_600_000 ? [Math.round(absolute / 60_000), "m"] : absolute < 86_400_000 ? [Math.round(absolute / 3_600_000), "h"] : [Math.round(absolute / 86_400_000), "d"];
  return delta < 0 ? `${size}${unit} ago` : `in ${size}${unit}`;
}

const STYLE = raw(`
@font-face{font-family:SSSMono;src:local("Iosevka"),local("IBM Plex Mono"),local("DejaVu Sans Mono")}*{box-sizing:border-box}html{background:#0b0d0c;color:#e8eee9;font-family:SSSMono,monospace}body{margin:0;background:radial-gradient(circle at 75% 5%,#18372c 0,transparent 34rem),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:auto,40px 40px;min-height:100vh}header,footer{height:72px;border-bottom:1px solid #303a34;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(20px,5vw,72px);background:#0b0d0ce8}.mark{display:flex;gap:14px;align-items:center}.mark b{font:800 28px/1 sans-serif;letter-spacing:-2px}.mark small,.eyebrow,.section-head span,dt,.state,.hash{font-size:10px;letter-spacing:.16em;color:#94a59a}.pulse{width:9px;height:9px;border-radius:50%;background:#a4ff47;box-shadow:0 0 18px #a4ff47}button{font:700 11px SSSMono;color:#dfffc2;background:transparent;border:1px solid #668c4b;padding:11px 14px;cursor:pointer}button,.button{min-height:44px}button:hover{background:#a4ff47;color:#071006}main{max-width:1440px;margin:auto;padding:0 clamp(20px,5vw,72px) 80px}.hero{min-height:370px;display:grid;grid-template-columns:1.4fr 1fr;align-items:center;border-bottom:1px solid #303a34}.eyebrow{color:#a4ff47}h1{font:500 clamp(48px,7vw,104px)/.87 sans-serif;letter-spacing:-.07em;margin:25px 0}h1 em{font-style:normal;color:#76837b}.telemetry{align-self:end;margin-bottom:58px}.telemetry dl{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#303a34}.telemetry dl div{background:#101411;padding:16px}.telemetry dd{font:500 34px sans-serif;margin:8px 0 0}.telemetry p{color:#76837b;font-size:11px}.warn,.error{color:#ff8d6b!important}.section-head{display:flex;justify-content:space-between;align-items:end;margin:65px 0 20px}.section-head h2{font:600 14px sans-serif;letter-spacing:.16em;margin:0}.scanner-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:10px}.scanner{background:#121713;border:1px solid #303a34;padding:22px;min-height:245px;position:relative}.scanner:hover{border-color:#668c4b}.scanner.degraded{border-top-color:#ff8d6b}.scanner-top{display:flex;justify-content:space-between}.state{color:#a4ff47}.scanner h3{font:500 24px/1.1 sans-serif;margin:36px 0 8px}.scanner>code{font-size:11px;color:#76837b}.facts{display:grid;grid-template-columns:1fr 1fr;margin:30px 0}.facts div{border-left:1px solid #39423d;padding-left:10px}.facts dd{font-size:12px;margin:6px 0}.scanner form{margin:0}.card-actions{display:flex;gap:10px;justify-content:space-between;align-items:center;margin-top:20px}.error{font-size:10px;max-height:2.4em;overflow:hidden}.events{border-top:1px solid #303a34}.event{display:grid;grid-template-columns:170px 130px 1fr auto;gap:20px;align-items:center;min-height:92px;border-bottom:1px solid #252c28}.event time,.event-kind{font-size:10px;color:#829087}.event-kind{text-transform:uppercase;color:#a4ff47}.event h3{font:500 15px sans-serif;margin:0 0 5px}.event p{font-size:11px;color:#94a59a;margin:0}.event a{font-size:10px;color:#dfffc2;text-decoration:none}.empty{padding:60px 20px;color:#76837b;border:1px dashed #39423d}footer{border-top:1px solid #303a34;border-bottom:0;height:60px;color:#69756e;font-size:9px;letter-spacing:.15em}a{color:#dfffc2;text-underline-offset:3px}nav{display:flex;gap:22px;align-items:center}nav>a{font-size:11px}.home-link{text-decoration:none;color:inherit}.button{display:inline-block;font:700 11px SSSMono;color:#dfffc2;border:1px solid #668c4b;padding:11px 14px;text-decoration:none}.button:hover{background:#a4ff47;color:#071006}button:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid #a4ff47;outline-offset:4px}.detail{padding-top:48px;max-width:1100px}.detail-title{font-size:clamp(42px,7vw,72px);line-height:1.1;letter-spacing:-.05em}.help,.setup-steps{font:14px/1.7 SSSMono;color:#a9b7ae;max-width:80ch}.setup-steps{padding-left:24px}.setup-steps li{padding:5px 0}.editor{margin:30px 0}.editor label{display:block;margin-bottom:12px;font-size:13px}.editor textarea{display:block;width:100%;resize:vertical;background:#101411;color:#e8eee9;border:1px solid #668c4b;padding:18px;font:13px/1.6 SSSMono;tab-size:2}.editor-actions{display:flex;align-items:center;gap:24px;margin-top:18px}.editor-actions a{font-size:12px}.notice{border:1px solid #668c4b;background:#122514;padding:20px;font-size:13px}.notice h2{font-size:16px}.notice pre,.example{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.65 SSSMono}.failure{border-color:#a34d35;background:#261811}.failure pre{color:#ffac94}.setup{margin-top:50px}.notification-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px}.notification-card{padding:22px;border:1px solid #303a34;background:#121713;min-width:0}.notification-card h3{font:500 23px/1.2 sans-serif;margin:25px 0}.notification-card code{font-size:11px;overflow-wrap:anywhere}.connection div{margin:20px 0}.connection dd{font-size:13px;margin:8px 0 0;overflow-wrap:anywhere}.example{padding:24px;background:#121713;border:1px solid #303a34}@media(max-width:760px){.hero{grid-template-columns:1fr}.telemetry{align-self:auto}.event{grid-template-columns:1fr;gap:6px;padding:18px 0}.mark small{display:none}header{height:auto;min-height:72px;gap:15px;padding-top:14px;padding-bottom:14px;flex-wrap:wrap}nav{gap:15px}main.detail{padding-top:30px}.detail .section-head{align-items:start;gap:15px;flex-direction:column}.editor textarea{padding:12px;font-size:16px}.editor-actions{gap:15px;flex-wrap:wrap}.help,.setup-steps{font-size:13px}footer{letter-spacing:.06em;gap:12px}}
`);
