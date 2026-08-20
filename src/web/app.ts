import { randomBytes, timingSafeEqual } from "node:crypto";
import { html, raw } from "hono/html";
import { Hono } from "hono";
import type { ChangeEvent, MonitorStatus } from "../core/types.ts";
import { Store, type DeliveryHealth } from "../store/database.ts";

export type DashboardActions = { run: (id: string) => Promise<unknown>; sync: () => Promise<unknown> };

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

  app.get("/", (context) => context.html(page(store.status(), store.events(40), store.deliveryHealth(), token)));
  app.post("/run/:id", async (context) => {
    if (!validPostLength(context.req.header("content-length"))) return context.text("request body too large", 413);
    const body = await context.req.parseBody();
    if (!tokenEquals(body["csrf"], token)) return context.text("invalid CSRF token", 403);
    await actions.run(context.req.param("id"));
    return context.redirect("/", 303);
  });
  app.post("/sync", async (context) => {
    if (!validPostLength(context.req.header("content-length"))) return context.text("request body too large", 413);
    const body = await context.req.parseBody();
    if (!tokenEquals(body["csrf"], token)) return context.text("invalid CSRF token", 403);
    await actions.sync();
    return context.redirect("/", 303);
  });
  return app;
}

function validPostLength(value: string | undefined): boolean {
  return value === undefined || /^\d+$/.test(value) && Number(value) <= 8_192;
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

function page(monitors: MonitorStatus[], events: ChangeEvent[], delivery: DeliveryHealth, token: string) {
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
          <form method="post" action="/sync"><input type="hidden" name="csrf" value=${token}><button>SYNC RECIPES</button></form>
        </header>
        <main>
          <section class="hero">
            <div><p class="eyebrow">LOCAL OBSERVATION DECK</p><h1>Watch the web.<br><em>Keep the evidence.</em></h1></div>
            <div class="telemetry"><dl><div><dt>ACTIVE</dt><dd>${active}</dd></div><div><dt>DEGRADED</dt><dd class=${degraded ? "warn" : ""}>${degraded}</dd></div><div><dt>RECENT EVENTS</dt><dd>${events.length}</dd></div></dl><p>SSS captures sources, stores durable history, and alerts on state transitions.${delivery.failed ? ` ${delivery.failed} alert ${delivery.failed === 1 ? "delivery has" : "deliveries have"} failed.` : ""}</p></div>
          </section>
          <section><div class="section-head"><h2>MONITORS</h2><span>${monitors.length} configured</span></div>
            <div class="scanner-grid">${monitors.length ? monitors.map((monitor) => monitorCard(monitor, token)) : html`<div class="empty">No monitors exist yet. Run <code>sss new research papers</code> to create a recipe.</div>`}</div>
          </section>
          <section><div class="section-head"><h2>EVENT LOG</h2><span>new and changed items</span></div>
            <div class="events">${events.length ? events.map(eventRow) : html`<div class="empty">No events exist yet.</div>`}</div>
          </section>
        </main>
        <footer><span>127.0.0.1 · PRIVATE BY DEFAULT</span><span>SSS / v0.1</span></footer>
      </body>
    </html>`;
}

function monitorCard(monitor: MonitorStatus, token: string) {
  const state = !monitor.enabled ? "PAUSED" : monitor.errorStreak ? "DEGRADED" : monitor.lastSuccessAt ? "WATCHING" : "UNPRIMED";
  return html`<article class="scanner ${monitor.errorStreak ? "degraded" : ""}">
    <div class="scanner-top"><span class="state">${state}</span><span class="hash">${monitor.namespace.slice(0, 8)}</span></div>
    <h3>${monitor.name}</h3><code>${monitor.id}</code>
    <dl class="facts"><div><dt>LAST SUCCESS</dt><dd>${relative(monitor.lastSuccessAt)}</dd></div><div><dt>NEXT RUN</dt><dd>${monitor.enabled ? relative(monitor.nextDueAt) : "—"}</dd></div></dl>
    ${monitor.lastError ? html`<p class="error">${monitor.lastError}</p>` : ""}
    <form method="post" action=${`/run/${encodeURIComponent(monitor.id)}`}><input type="hidden" name="csrf" value=${token}><button>RUN NOW <span>↗</span></button></form>
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
@font-face{font-family:SSSMono;src:local("Iosevka"),local("IBM Plex Mono"),local("DejaVu Sans Mono")}*{box-sizing:border-box}html{background:#0b0d0c;color:#e8eee9;font-family:SSSMono,monospace}body{margin:0;background:radial-gradient(circle at 75% 5%,#18372c 0,transparent 34rem),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:auto,40px 40px;min-height:100vh}header,footer{height:72px;border-bottom:1px solid #303a34;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(20px,5vw,72px);background:#0b0d0ce8}.mark{display:flex;gap:14px;align-items:center}.mark b{font:800 28px/1 sans-serif;letter-spacing:-2px}.mark small,.eyebrow,.section-head span,dt,.state,.hash{font-size:10px;letter-spacing:.16em;color:#94a59a}.pulse{width:9px;height:9px;border-radius:50%;background:#a4ff47;box-shadow:0 0 18px #a4ff47}button{font:700 11px SSSMono;color:#dfffc2;background:transparent;border:1px solid #668c4b;padding:11px 14px;cursor:pointer}button:hover{background:#a4ff47;color:#071006}main{max-width:1440px;margin:auto;padding:0 clamp(20px,5vw,72px) 80px}.hero{min-height:370px;display:grid;grid-template-columns:1.4fr 1fr;align-items:center;border-bottom:1px solid #303a34}.eyebrow{color:#a4ff47}h1{font:500 clamp(48px,7vw,104px)/.87 sans-serif;letter-spacing:-.07em;margin:25px 0}h1 em{font-style:normal;color:#76837b}.telemetry{align-self:end;margin-bottom:58px}.telemetry dl{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#303a34}.telemetry dl div{background:#101411;padding:16px}.telemetry dd{font:500 34px sans-serif;margin:8px 0 0}.telemetry p{color:#76837b;font-size:11px}.warn,.error{color:#ff8d6b!important}.section-head{display:flex;justify-content:space-between;align-items:end;margin:65px 0 20px}.section-head h2{font:600 14px sans-serif;letter-spacing:.16em;margin:0}.scanner-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:10px}.scanner{background:#121713;border:1px solid #303a34;padding:22px;min-height:245px;position:relative}.scanner:hover{border-color:#668c4b}.scanner.degraded{border-top-color:#ff8d6b}.scanner-top{display:flex;justify-content:space-between}.state{color:#a4ff47}.scanner h3{font:500 24px/1.1 sans-serif;margin:36px 0 8px}.scanner>code{font-size:11px;color:#76837b}.facts{display:grid;grid-template-columns:1fr 1fr;margin:30px 0}.facts div{border-left:1px solid #39423d;padding-left:10px}.facts dd{font-size:12px;margin:6px 0}.scanner form{position:absolute;right:18px;bottom:18px}.error{font-size:10px;max-height:2.4em;overflow:hidden}.events{border-top:1px solid #303a34}.event{display:grid;grid-template-columns:170px 130px 1fr auto;gap:20px;align-items:center;min-height:92px;border-bottom:1px solid #252c28}.event time,.event-kind{font-size:10px;color:#829087}.event-kind{text-transform:uppercase;color:#a4ff47}.event h3{font:500 15px sans-serif;margin:0 0 5px}.event p{font-size:11px;color:#94a59a;margin:0}.event a{font-size:10px;color:#dfffc2;text-decoration:none}.empty{padding:60px 20px;color:#76837b;border:1px dashed #39423d}footer{border-top:1px solid #303a34;border-bottom:0;height:60px;color:#69756e;font-size:9px;letter-spacing:.15em}@media(max-width:760px){.hero{grid-template-columns:1fr}.telemetry{align-self:auto}.event{grid-template-columns:1fr;gap:6px;padding:18px 0}.mark small{display:none}}
`);
