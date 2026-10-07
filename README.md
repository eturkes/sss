# Super Smart Scanner

SSS watches web sources from a local machine. Each YAML recipe configures one monitor and its alert channels.
SQLite stores the last accepted observation. A failed scan cannot create a false change.

```text
recipe → acquire → extract → validate → normalize → compare → event → outbox
```

Use SSS to:

- find new research that matches a query;
- alert when a fare quote crosses below a target;
- detect a changed page field or a new keyed list item;
- read allowed authenticated pages through BrowserOS.

SSS observes sources but does not bypass CAPTCHAs, make purchases, or guarantee exhaustive research coverage.
It treats one airfare quote as one observation, not a universal market price.

## Start

Install Node `>=24.15 <27` and pnpm 11.

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

Open <http://127.0.0.1:7337>. `serve` runs the scheduler, alert outbox, and dashboard.
Use `daemon` to run the scheduler and delivery worker without the dashboard.

| Command | Action |
|---|---|
| `sss init` | Create the private state and monitor directories. |
| `sss new research\|price\|page ID` | Create a disabled starter recipe. |
| `sss validate [ID\|PATH]` | Parse the recipe policy and schema without network access. |
| `sss test ID\|PATH` | Acquire and extract without writing state or alerts. |
| `sss run ID\|PATH` | Run one monitor through the durable pipeline. |
| `sss sync` | Reconcile recipes with SQLite. Pause monitors without recipes. |
| `sss status [--json]` | Show separate attempt, success, schedule, and delivery health. |
| `sss events [--json] [--limit N]` | Show the event inbox. |
| `sss history MONITOR [ITEM] [--json] [--limit N]` | Show accepted observations. |
| `sss deliveries [--json] [--limit N]` | Show pending and failed alert deliveries. |
| `sss doctor` | Check the runtime, recipes, SQLite, and BrowserOS. |
| `sss draft 'watch …'` | Ask isolated Codex to produce schema-constrained JSON. |
| `sss serve [--port 7337]` | Run the dashboard, scheduler, and delivery worker. |
| `sss daemon` | Run the scheduler and delivery worker. |

## Recipe contract

Put one version 1 recipe in each `monitors/*.yaml` file.
See [`examples/`](./examples) for complete research, price, and page recipes.

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
| `feed` | Reads RSS, Atom, and arXiv API feeds. | Resolves identity from a DOI, arXiv ID, canonical URL, or provider ID. |
| `json` | Reads supported APIs. | Uses safe dotted paths and explicit field mappings. |
| `html` | Reads static pages. | Uses Cheerio CSS selectors without script execution. |
| `openalex` | Searches research. | Requires `OPENALEX_API_KEY` and uses stable work IDs. |
| `browseros` | Reads signed-in or dynamic pages. | Uses direct, read-only MCP calls through a fixed local endpoint. |

Prefer official APIs and feeds over page scraping. When a page needs an authenticated browser session, use BrowserOS.
A scheduled BrowserOS recipe can navigate to and read allowed origins.
It cannot click, fill forms, download, evaluate JavaScript, or access app connectors.

### Rules and bootstrapping

- `new_items` alerts once for identities that appear after priming.
- `field_changed` alerts when one normalized field changes.
- `crosses_below` alerts on a downward crossing and re-arms above the threshold. It stays quiet below the threshold.
- `numeric_delta` alerts on configured absolute or percentage movement. It can restrict the direction.

By default, `bootstrap: suppress_existing` suppresses alerts during the first accepted scan.
When the first accepted value must trigger an existing condition, use `evaluate_current`.

If a valid query can return no items, set `assertions.allowEmpty: true`.
Malformed feeds and login pages still degrade the run.

A source, assertion, or rule change creates a new semantic namespace.
SSS establishes a compatible baseline without an alert. Schedule, name, notification, and health changes keep existing state.
Changing rule enablement re-primes the rule and prevents a false edge.

SSS represents money as `{ minor: integer, currency: ISO-4217 }`.
Specify an explicit currency for every money extractor. SSS rejects negative, ambiguous, or conflicting-currency values.
For a quote, add its itinerary, date, and passenger count to `requiredFields` and `invariantFields`.
If that context changes, the scan degrades and skips the price comparison.

### Notifications

The dashboard inbox stores every event durably. Add optional channels to a recipe:

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

SSS uses at-least-once delivery. It commits each event before delivery.
Failed deliveries retry with bounded exponential backoff. A delivery failure does not fail the scan.
A retried channel can receive a duplicate.

Reference secrets through environment variables. SSS removes their values from errors and status output.
`sss status`, `sss deliveries`, `sss doctor`, and `/api/deliveries` show the delivery backlog and failures.

## Safety model

- General acquisition accepts only public HTTP(S) targets.
  SSS checks DNS and every redirect.
  It rejects private, loopback, link-local, metadata, mixed-answer, mapped, and unusual numeric IP forms.
  It pins the validated address to the connection.
- SSS limits response bytes, redirect count, and elapsed time. It ignores proxy environment variables.
- Extracted text remains inert data.
  It cannot start recursive fetches, shell commands, `eval`, remote image loads, or tool-enabled agent loops.
- The dashboard binds to loopback and rejects foreign `Host` and `Origin` values.
  It uses CSRF tokens, output escaping, and a restrictive Content Security Policy.
- SSS creates `.sss/` with mode `0700`. It does not retain raw authenticated response bodies.
- SSS retains accepted observations for 180 days and always retains the latest item snapshot.
  It retains unreferenced runs and successful deliveries for 30 days.

## BrowserOS and Codex

Use BrowserOS only for pages that require an existing authenticated browser session.
SSS uses the fixed MCP endpoint `http://127.0.0.1:9000/mcp`.
Before you enable a BrowserOS recipe, set `SSS_BROWSEROS_ORIGINS` to the permitted origins.
Separate multiple origins with commas.

[`examples/browseros-price.yaml`](./examples/browseros-price.yaml) demonstrates typed selector reads for an authenticated fare.
BrowserOS content remains data. SSS permits only direct `tabs`, `navigate`, and `read` calls.

`sss draft` starts an ephemeral `codex exec` process.
The process receives read-only filesystem access and no user MCP configuration.
It uses a strict output schema, `gpt-5.6-sol`, and maximum reasoning.
Codex writes recipes. Page content cannot control a tool-enabled Codex session.

## Service

Install the bundled [`deploy/sss.service`](./deploy/sss.service) user service.
Before you start the service, edit its paths:

```bash
install -Dm644 deploy/sss.service ~/.config/systemd/user/sss.service
$EDITOR ~/.config/systemd/user/sss.service
systemctl --user daemon-reload
systemctl --user enable --now sss.service
```

Put required secrets and `SSS_BROWSEROS_ORIGINS` in `~/.config/sss.env`.
Set the file mode to `0600`. The unit loads this file without storing secrets in the repository.

By default, SSS stores state in `.sss/sss.db`.
Set `SSS_STATE_DIR` and `SSS_MONITORS_DIR` to override the default paths.
Before you back up the database, stop SSS. Alternatively, use SQLite's online backup API.

The bundled airfare recipes demonstrate selector and invariant patterns. They are not provider adapters.
Replace the placeholder URL and selectors. Use one immutable route, date, passenger count, and search result.
SSS reads quotes but does not fill search forms or buy tickets.

## Develop

Run the checks:

```bash
pnpm check
pnpm test
pnpm test:coverage
```

The tests use fixtures. They do not change external services.
