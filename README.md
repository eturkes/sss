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
- assess X posts and replies for subtle signals with a model;
- send matching observations through a configured email account.

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
Select **Edit recipe** to change an existing monitor. Save validates the YAML and applies the recipe without a scan.
The editor rejects stale edits and active scans. Keep the monitor ID and use environment references for credentials.

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
| `sss artifacts [MONITOR] [--json] [--limit N]` | Show retained observation files and their expiry times. |
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
| `crossref` | Searches Crossref works. | Traverses opaque cursors with DOI identities and a fixed index-time bound. |
| `arxiv` | Searches the arXiv API. | Traverses offsets with versionless identities and a fixed submission-time bound. |
| `playwright` | Renders anonymous dynamic pages. | Uses a fresh browser with public, read-only request interception. |
| `browseros` | Reads signed-in or dynamic pages. | Uses direct, read-only MCP calls through a fixed local endpoint. |
| `x` | Reads an account's posts and replies through BrowserOS Neo. | Paginates Latest search until an accepted post overlaps. |
| `sel4_news` | Reads official seL4 news archives. | Traverses every publisher-listed year and preserves year-specific article anchors. |

Prefer official APIs and feeds over page scraping. When a page needs an authenticated browser session, use BrowserOS.
Item URLs retain fragment anchors because different sections can identify different records.
Feed acquisition collapses exact duplicates. If one identity has conflicting records, the scan fails and preserves the accepted baseline.
If a publisher shares destination URLs across announcements, set `source.identity: provider` on its feed recipe.
This mode uses the publisher's RSS GUID or Atom ID. Every entry must have a nonempty ID.
SSS stores nested feed content and its link destinations unchanged. Email converts feed markup into readable text and links.
A scheduled BrowserOS recipe can navigate to and read allowed origins.
It cannot click, fill forms, download, evaluate JavaScript, or access app connectors.

Crossref and arXiv use `query`, optional `perPage` (default `100`), and optional `maxPages` (default `100`).
arXiv also accepts `lookbackDays` from `1` to `365`. This option freezes a rolling submission window for each complete scan.
Crossref also accepts a `filter` mapping. SSS reserves `until-index-date` for the scan bound.
Each scan must acquire the complete bounded query. A changed count, repeated identity, missing page, or limit degrades the scan.
The hard limit is 10,000 items. Narrow a query that exceeds the limit.
arXiv requests use one connection at a time with at least three seconds between requests in each process.
These APIs do not provide an atomic snapshot. A frozen time bound cannot prevent every indexing change.
See [the Crossref example](./examples/research-crossref.yaml) and [the arXiv example](./examples/research-arxiv.yaml).

For an anonymous dynamic page, use Linux with working Bubblewrap (`bwrap`) and user namespaces.
Install the bundled browser in the project cache:

```bash
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.sss/browser-cache"
pnpm exec playwright install chromium --no-shell
```

Use `type: playwright` with the HTML field mappings and a required `waitForSelector`.
SSS waits for that selector before it extracts the rendered DOM. Choose a selector that marks a complete result.
Keep `PLAYWRIGHT_BROWSERS_PATH` set when you run SSS. For the service, set its absolute cache path in the service environment file.
The browser runs in a separate network namespace. The root filesystem is read-only. The temporary profile and device filesystem are private.
Every document and subresource request uses the public-network policy. Requests must use GET or HEAD.
Redirects, credentials, WebSockets, service workers, popups, and downloads are blocked.
The source has no persistent login, custom script, click, or form action.
Acquisition fails when the request, byte, or time limit is reached.
See [the dynamic page example](./examples/playwright-page.yaml).

### Rules and bootstrapping

- `new_items` alerts once for identities that appear after priming.
- `field_changed` alerts when one normalized field changes.
- `crosses_below` alerts on a downward crossing and re-arms above the threshold. It stays quiet below the threshold.
- `numeric_delta` alerts on configured absolute or percentage movement. It can restrict the direction.
- `llm_assessment` alerts when `gpt-6.1-sol` with `xhigh` reasoning judges an observation suggestive.

An assessment rule includes a trusted `prompt` rubric. Acquired text and conversations remain inert evidence.
Set `product: claude` for Claude.ai and Claude Code allowance resets. The default product is `codex`.
SSS stores positive and negative judgments. By default, it reassesses changed posts but skips unchanged posts.
The revision key covers the complete observation JSON, including its title, URL, publication time, and extracted data.
Object key order and acquisition time do not trigger reassessment.
Set `trigger: new_item` to assess each accepted identity once. Edits, quote changes, and returning identities do not trigger inference.
An unaccepted post can retry after an assessment failure.
Old data-only cache entries refresh once in revision mode. A positive refresh can repeat an earlier alert.
The strict-new mode still skips accepted IDs before checking the revision key.
An assessment failure preserves the accepted baseline. The result describes a model interpretation, not a confirmed future event.

For general semantic matching, set `mode: semantic`, `target`, and a trusted `prompt` on an `llm_assessment` rule.
Keep the model and reasoning settings above. Omit `product` in this mode.
Use this rule alone when only matching items must create events. A parallel `new_items` rule still alerts on every new identity.
Positive and negative judgments use the same revision cache and failure handling as reset assessments.

By default, `bootstrap: suppress_existing` suppresses alerts during the first accepted scan.
When the first accepted value must trigger an existing condition, use `evaluate_current`.

If a valid query can return no items, set `assertions.allowEmpty: true`.
Malformed feeds and login pages still degrade the run.

A source, extraction-version, assertion, or rule change creates a new semantic namespace.
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
  - type: email
    account: gmail
    from: sender@example.com
    to: recipient@example.com
    events: [llm_assessment]
```

SSS uses at-least-once delivery. It commits each event before delivery.
Failed deliveries retry with bounded exponential backoff. A delivery failure does not fail the scan.
A retried channel can receive a duplicate.

Reference secrets through environment variables. SSS removes their values from errors and status output.
`sss status`, `sss deliveries`, `sss doctor`, and `/api/deliveries` show the delivery backlog and failures.

Email uses `msmtp` and its existing account configuration. Email shows the source link, complete readable content, model judgment, and evidence.
Feed markup becomes paragraphs, lists, and links. Images appear as descriptions and links; email does not load them.
Reset alerts separate the post, quoted context, assessment, and evidence. Model judgments remain interpretations, not confirmed resets.
Internal identifiers, JSON dumps, and scan tracebacks stay out of the email. The stored observations and diagnostic snapshots remain unchanged.
The optional `events` filter limits each channel to selected event kinds. The inbox still retains every event.

For a scheduled email digest, add the same `digest` configuration to each participating email channel:

```yaml
digest:
  id: formal-verification
  schedule: { cron: '0 9 * * *', timezone: Asia/Tokyo }
```

Channels with the same digest ID, schedule, recipient, sender, and account share one email.
The first email is due at the next scheduled time. Each email includes every queued observation, its complete readable content, and source health.
Scan failures and recoveries appear under source health, not in the observation count. Healthy sources share one status summary. Failed sources show a short error and their last successful scan.
SSS does not apply an item count or body-length cap to a digest. Acquisition safety limits still apply. An incomplete acquisition fails instead of accepting a truncated result.
An empty digest reports that no new observations were queued. Check its source-health section for failed or missing scans.
Failed emails retry with the same saved contents and message ID. New observations wait for the next digest.

### Daily formal-verification digest

The `monitors/fv-*.yaml` recipes collect updates each hour. They share one email digest at **09:00 Asia/Tokyo** through the configured Gmail account.
The sources cover:

- arXiv papers in logic, programming languages, formal verification, model checking, theorem proving, and proof assistants;
- release feeds for proof assistants, SMT solvers, program and hardware verifiers, and verified systems;
- Formal Methods Europe, the Rocq community, Frama-C, the TLA+ Foundation, the Archive of Formal Proofs, and seL4 news.

Frama-C uses its authored feed IDs because several announcements share one destination URL.
The seL4 news adapter reads the current index and every listed annual archive. It uses the publisher's year and article anchor for each permalink.
The seL4 observations include article text, links, and image metadata. Image-only announcements remain visible without fetching their images.

The digest includes prereleases and nightly releases when their release identities are new.
The first accepted scan establishes each source's baseline without sending historical entries.
Later digests contain newly observed identities, with the available abstracts, feed content, and source links.
Updated content at an existing identity does not create another entry.
These feeds and queries do not cover every announcement in the field. Feed entries can expire between scans.
The arXiv query uses a rolling 30-day submission window. An outage longer than that window can leave gaps.

Run the live acquisition check without state changes or email:

```bash
node scripts/check-formal-verification.ts
```

Select **Mobile alerts** in the dashboard to configure your phone for ntfy.
The guide shows each configured server and topic, subscription links, and environment variable names for authentication.
If no channel exists, copy its example into a recipe. Save the recipe, then subscribe in the ntfy mobile app.
The guide and editor do not send test notifications.

### Observation artifacts

Artifact storage is off by default. To retain exact extracted observations before normalization, add:

```yaml
artifacts: { retentionDays: 30 }
```

SSS stores JSON under `.sss/artifacts/<sha256>.json` with private file permissions.
Identical bytes share one file. Each accepted run has its own expiry reference.
The file contains the complete extracted items and optional diagnostics. It does not contain raw page bodies, browser profiles, or acquisition clocks.
The maximum file size is 16 MiB. An artifact write failure degrades the scan and preserves the accepted baseline.
Dry runs do not store artifacts. `sss artifacts` lists each reference and file path.
The scheduler removes expired references and unreferenced files during daily maintenance.
Expiry does not delete the latest accepted item snapshot. Back up the artifact directory with the database if you enable this option.

## Safety model

- General acquisition accepts only public HTTP(S) targets.
  SSS checks DNS and every redirect.
  It rejects private, loopback, link-local, metadata, mixed-answer, mapped, and unusual numeric IP forms.
  It pins the validated address to the connection.
- SSS limits response bytes, redirect count, and elapsed time. It ignores proxy environment variables.
- Extracted text remains inert data.
  It cannot start recursive fetches, shell commands, `eval`, arbitrary image loads, or tool-enabled agent loops.
- Assessment image acquisition accepts only HTTPS images under `pbs.twimg.com/media/`.
  SSS checks DNS, disables redirects, validates image signatures, and limits image sizes.
- The dashboard binds to loopback and rejects foreign `Host` and `Origin` values.
  It uses CSRF tokens, output escaping, and a restrictive Content Security Policy.
- SSS creates `.sss/` with mode `0700`. It does not retain raw authenticated response bodies.
- SSS retains accepted observations for 180 days and always retains the latest item snapshot.
  It retains unreferenced runs and successful deliveries for 30 days.

## BrowserOS and Codex

Use BrowserOS only for pages that require an existing authenticated browser session.
The X adapter uses the fixed Neo MCP endpoint `http://127.0.0.1:9200/mcp`.
The existing `browseros` adapter retains its fixed compatibility endpoint `http://127.0.0.1:9000/mcp`.
Before you enable a BrowserOS recipe, set `SSS_BROWSEROS_ORIGINS` to the permitted origins.
Separate multiple origins with commas.

[`examples/browseros-price.yaml`](./examples/browseros-price.yaml) demonstrates typed selector reads for an authenticated fare.
BrowserOS content remains data. SSS permits only direct `tabs`, `navigate`, and `read` calls.

`sss draft` starts an ephemeral `codex exec` process.
The process receives read-only filesystem access and no user MCP configuration.
It uses a strict output schema, `gpt-5.6-sol`, and maximum reasoning.
Codex writes recipes. Page content cannot control a tool-enabled Codex session.

Assessment uses the existing Codex ChatGPT login and the fixed Codex inference endpoint.
Each inference request specifies `tools: []`, `tool_choice: none`, `gpt-6.1-sol`, and `xhigh` reasoning.
SSS rejects tool-call output and incomplete responses. Codex model discovery refreshes expired login credentials without receiving page content.

### Usage-reset monitors

[`monitors/thsottiaux-codex-reset.yaml`](./monitors/thsottiaux-codex-reset.yaml) watches `@thsottiaux` for Codex usage-limit reset hints every five minutes.
[`monitors/claudedevs-claude-reset.yaml`](./monitors/claudedevs-claude-reset.yaml) watches `@ClaudeDevs` for Claude.ai and Claude Code usage-reset hints on the same schedule.
Both use `gpt-6.1-sol` with `xhigh` reasoning. They send matching observations to the configured Gmail recipient.
Both favor recall over precision. A plausible reset hint can trigger an alert even when the product or timing is implicit.
The trusted rubric supplies the account context. Fresh confirmations of completed resets also qualify.
Clearly unrelated posts and clearly other-product-only resets remain outside the target.
The five-minute poll uses deterministic BrowserOS reads, not inference. Only unseen post or reply IDs reach the model.
It includes authored posts, replies, emojis, quoted text, parent context, and accessible attached images.
The first accepted scan suppresses existing posts. Matching future observations send email to the configured recipient.
The first-scan boundary also suppresses historical posts that later page loads expose.
Health failures and recovery remain in the inbox. They do not send reset-hint email.

The X adapter uses Latest search without a keyword filter. It verifies each post's primary author before pagination.
It reads full posts, including edited posts, and preserves reply and quote context. Display timestamps cannot trigger another assessment.
For known IDs, these monitors reuse accepted content and do not reopen post pages.
Missing overlap, incomplete posts, login errors, and acquisition limits degrade the scan.
X search can omit unindexed or deleted posts. This browser source cannot guarantee exhaustive coverage.
Videos are not transcribed. Image assessment requires accessible X image URLs.

Keep the machine and BrowserOS Neo running. Keep the X session, Codex login, and email account authenticated.
Run `sss validate`, `sss test`, and `sss doctor` before you enable the recipe.
When only the X assessment trigger becomes stricter, SSS inherits acquisition history without copying old judgments or creating alerts.
The version 4 X parser upgrade also preserves compatible strict-new history and the original startup cutoff from versions 1, 2, and 3.

When you deploy a prompt-only update to either bundled reset monitor, stop the scheduler first.
Before you run `sss sync` or restart the scheduler, run this command for each changed monitor:

```bash
node scripts/upgrade-reset-rubrics.ts thsottiaux-codex-reset
node scripts/upgrade-reset-rubrics.ts claudedevs-claude-reset
```

The command preserves accepted IDs and the startup cutoff in the new namespace. It leaves old judgments intact in the old namespace.
New posts still receive an assessment. Previously accepted posts stay quiet, including cached false negatives.
The command rejects changes outside the prompt. You can repeat the command safely.

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
PLAYWRIGHT_BROWSERS_PATH="$PWD/.sss/browser-cache" node scripts/check-playwright.ts
```

The tests use fixtures. They do not change external services.
The Playwright check requires the installed Chromium build. It verifies dynamic rendering and blocked network/action paths with local fixtures.

Run the live reset-assessment regression separately:

```bash
pnpm eval:resets
pnpm eval:resets tibo-reset-day tibo-reset-followup
```

This command uses the configured Codex login and consumes inference quota. It does not write scanner state or send alerts.
It checks the bundled recipes against observed posts and synthetic positive and negative cases.
Model results can vary. A successful run does not guarantee that future posts receive the intended judgment.
