# Super Smart Scanner

SSS is a local observation engine for things on the web. A YAML recipe says what to collect, what counts as valid, which transition matters, and where to alert. SQLite remembers the last **accepted** observation; failures never become fake changes.

```text
recipe → acquire → extract → validate → normalize → compare → event → outbox
```

Good fits:

- newly observed research matching a query;
- a fare quote crossing below a target;
- a page field changing or a keyed list gaining an item;
- authenticated pages through an explicit, read-only BrowserOS source.

SSS does not bypass CAPTCHAs, purchase anything, claim exhaustive research coverage, or treat one airfare quote as a universal market price.

## Start

Requires Node `>=24.15 <27` and pnpm 11. The workstation already has Node 26 + pnpm.

```bash
pnpm install
pnpm sss init
pnpm sss new research papers
$EDITOR monitors/papers.yaml
pnpm sss validate
pnpm sss test papers
pnpm sss run papers
pnpm sss serve
```

Open <http://127.0.0.1:7337>. `serve` owns the scheduler, alert outbox, and dashboard. `daemon` runs the same workers without the dashboard.

Common commands:

```text
sss init                         create private state/config directories
sss new research|price|page ID  create a disabled starter recipe
sss validate [ID|PATH]          parse policy + schema without network access
sss test ID                     acquire/extract with no state or alert writes
sss run ID                      run once through the durable pipeline
sss sync                         reconcile YAML → SQLite; removed recipes pause
sss status                       show attempt/success/schedule health separately
sss events [--json]             inspect the signal inbox
sss history MONITOR [ITEM]      inspect immutable accepted observations
sss deliveries                  inspect pending/failed alert delivery
sss doctor                       verify runtime, recipes, SQLite, BrowserOS
sss draft 'watch …'              ask isolated Codex for schema-constrained JSON
sss serve [--port 7337]          dashboard + scheduler + delivery worker
sss daemon                       scheduler + delivery worker
```

## Recipe contract

Each `monitors/*.yaml` file contains one version-1 recipe. See [`examples/`](./examples) for complete research, price, and page monitors.

```yaml
version: 1
id: example-page
name: Example heading
enabled: true
schedule: { every: 30m }
source:
  type: html
  url: https://example.com/
  fields:
    heading: { selector: h1 }
assertions:
  minItems: 1
  maxItems: 1
  requiredFields: [heading]
rules:
  - { id: heading-change, type: field_changed, field: heading }
notifications:
  - { type: inbox }
  - { type: desktop }
health: { failuresBeforeAlert: 3 }
```

### Sources

| Type | Use | Notes |
|---|---|---|
| `feed` | RSS, Atom, arXiv API feeds | DOI → arXiv ID → canonical URL → provider ID identity |
| `json` | supported APIs | safe dotted paths + explicit field mapping |
| `html` | static pages | Cheerio CSS selectors; no script execution |
| `openalex` | research search | needs `OPENALEX_API_KEY`; stable work IDs |
| `browseros` | signed-in/dynamic pages | direct MCP navigation/read only; fixed local endpoint |

Prefer official APIs/feeds over page scraping. BrowserOS is a high-trust exception: scheduled recipes can navigate and read allowed origins, but cannot click, fill forms, download, evaluate JavaScript, or access app connectors.

### Rules and bootstrapping

- `new_items`: alert once for identities first seen after priming.
- `field_changed`: compare one normalized field.
- `crosses_below`: edge-triggered; quiet while below, re-arm above, alert on the next crossing.
- `numeric_delta`: absolute and/or percentage movement, optionally directional.

`bootstrap: suppress_existing` is the default. Use `evaluate_current` for conditions such as “tell me immediately if the first observed fare is already below the target.” For a valid query that may return zero items, set `assertions.allowEmpty: true`; malformed feeds/login pages still degrade. Source/assertion/rule changes create a new semantic namespace and silently establish a compatible baseline. Schedule, name, notification, and health changes retain state. Rule enablement changes re-prime to prevent a fabricated edge.

Money is `{ minor: integer, currency: ISO-4217 }`. Money extractors require an explicit currency and reject negative, ambiguous, conflicting-currency values. Put quote context such as itinerary/date/passenger count in both `requiredFields` and `invariantFields`; any context drift then degrades instead of triggering a price comparison.

### Notifications

The dashboard inbox is always durable. Optional channels:

```yaml
notifications:
  - { type: desktop }
  - type: ntfy
    url: https://ntfy.sh
    topic: my-private-topic
    token: { env: NTFY_TOKEN }
  - type: webhook
    url: https://example.net/sss
    headers: { Authorization: { env: SSS_WEBHOOK_AUTH } }
```

Delivery is at-least-once. An event commits before delivery; failed deliveries retry with bounded exponential backoff and never make the scan itself fail. Secrets use environment references and are excluded from errors/status.
`sss status`, `sss deliveries`, `sss doctor`, and `/api/deliveries` expose delivery backlog/failures.

## Safety model

- General acquisition allows public HTTP(S) only. DNS and every redirect are checked; private, loopback, link-local, metadata, mixed-answer, mapped, and unusual numeric IP forms are rejected. The validated address is pinned for the connection.
- Response bytes, redirects, and time are bounded. Proxy environment variables are ignored.
- Extracted text is inert data: no recursive fetches, shell, `eval`, remote images, or tool-capable agent loop.
- Dashboard binds to loopback and rejects foreign `Host`/`Origin`, uses CSRF tokens, escaping, and a restrictive CSP.
- `.sss/` is private (`0700`); raw authenticated bodies are not retained.
- Accepted observations retain 180 days (latest item snapshot always retained); unreferenced runs and successful deliveries retain 30 days.

## BrowserOS + Codex

BrowserOS was chosen only for pages needing the existing authenticated browser. Its MCP endpoint is fixed to `http://127.0.0.1:9000/mcp`; set `SSS_BROWSEROS_ORIGINS` to comma-separated permitted origins before enabling such a recipe.

[`examples/browseros-price.yaml`](./examples/browseros-price.yaml) shows typed selector reads for an authenticated fare. BrowserOS content stays data; only direct `tabs`, `navigate`, and `read` calls are available.

`sss draft` runs `codex exec` ephemerally with read-only filesystem access, no user MCP configuration, a strict output schema, `gpt-5.6-sol`, and maximum reasoning. Codex authors recipes; page content never drives a tool-capable Codex session.

## Service

Copy and edit [`deploy/sss.service`](./deploy/sss.service), then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now sss.service
```

Put required secret variables and `SSS_BROWSEROS_ORIGINS` in `~/.config/sss.env` with mode `0600`; the unit loads it without storing secrets in this repository.

State defaults to `.sss/sss.db`. Override paths with `SSS_STATE_DIR` and `SSS_MONITORS_DIR`. Back up the SQLite database only while stopped, or use SQLite's online backup API.

The bundled airfare recipes are selector/invariant patterns, not provider adapters: replace the placeholder URL/selectors with one immutable route/date/passenger search result. SSS reads quotes; it does not fill search forms or buy tickets.

## Develop

```bash
pnpm check
pnpm test
pnpm test:coverage
```

The tests are fixture-backed and make no external writes.
