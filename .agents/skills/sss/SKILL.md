---
name: sss
description: Author, debug, or extend Super Smart Scanner monitor recipes and adapters.
---

# SSS workflow

1. Read `README.md` + `src/config/schema.ts`; inspect the target recipe.
2. Acquisition must stay deterministic: prefer official API/feed → JSON/static HTML → allowlisted BrowserOS.
3. Define stable identity + completeness assertions before rules. Set `allowEmpty` only for complete queries where zero results is valid. Fare context belongs in `requiredFields` + `invariantFields`.
4. Use `bootstrap: suppress_existing` for corpora; use `evaluate_current` for current-condition alerts.
5. Run `pnpm sss validate ID|PATH`, then `pnpm sss test ID|PATH`; degraded/skipped exits nonzero. Explain extracted identities/fields before enabling.
6. Run the repository gate from `AGENTS.md`; preserve fixture-backed regression coverage.

Item URL identity = preserve publisher fragment anchors + strip tracking parameters. Resource-only URLs may drop fragments; keep that normalization separate. Feeds collapse exact duplicate observations and reject conflicting payloads for one identity before keyword filtering. Shared-page/reused-GUID feeds need a stable official alternate source; use publisher permalinks, never mutable text/content hashes as invented identities.

Shared feed destination + unique authored IDs = `source.identity:provider`; require every GUID/Atom ID, preserve opaque strings, reject conflicts. Frama-C uses this mode. Nested feed text/markup/link destinations must survive acquisition → accepted state → digest unchanged. seL4 news = `sel4_news`; acquire current index + every listed year, use canonical year/anchor URLs, retain body links + inert image metadata. Empty/malformed stories, missing archives, catalog drift + bounds degrade without replacing the baseline.

Research = `crossref` cursor or `arxiv` offset source; bounded complete query + fixed time bound; count drift/duplicate identities/incomplete pages degrade. Narrow oversized queries. Selective semantic alerts = sole `llm_assessment` rule with `mode:semantic`, trusted `target`/`prompt`, exact assessment model/effort; omit reset `product`. Parallel deterministic rules keep their own event behavior.

Ongoing arXiv monitoring = `lookbackDays` rolling submission window; freeze lower/upper bounds through complete traversal. Select a window longer than expected downtime; expire old candidates without deleting accepted identities. Formal-verification bundled sources = `monitors/fv-*.yaml`; live batch dry run = `node scripts/check-formal-verification.ts` (ephemeral state, no inference/delivery).

Daily email = shared notification `digest:{id,schedule:{cron,timezone}}` + identical recipient/sender/account; source scan schedules stay independent. First due = next cron occurrence. Full event membership/content + source-health snapshot; no editorial count/body cap. Failed batches retain exact membership + message ID; later observations wait for the next digest. Empty digests still report source health. Validate first, verify email authentication without sending, dry-run acquisition, enable + prime historical baselines, then verify persisted route due time.

Anonymous dynamic pages = `playwright` HTML mappings + required readiness selector; Linux + working Bubblewrap/user namespaces. Set `PLAYWRIGHT_BROWSERS_PATH` to project-local `.sss/browser-cache`; install Chromium through `pnpm exec playwright install chromium --no-shell`; verify fixture boundary through `node scripts/check-playwright.ts` with the same cache environment. Fresh sandbox/context + mandatory isolated network namespace; root read-only + private writable profile; public policy-mediated GET/HEAD; bounded requests/bytes/time; final URL only; no auth/profile/actions. Authenticated pages stay on Neo.

Dashboard editor = existing recipes only, immutable ID/path, bounded strict YAML, env-ref secrets, private atomic save + revision CAS, final DB/scan fence. No acquisition/delivery on save; rename/DB failure blocks scans until reconciliation. Opt-in `artifacts:{retentionDays}` stores content-addressed exact extracted observation JSON + accepted-run references; default/dry-run retain nothing; retention runs under the DB acceptance lock.

Assessment recipes = exact model/effort + trusted rubric + stable authored identity; `product:codex|claude` selects usage-allowance scope, Codex default; preserve existing default namespaces. Raw text/Unicode/context preserved. `trigger:new_item` → accepted IDs never reach inference again; default `new_or_changed` preserves revision behavior. Strict-new X polling reuses accepted known payloads; full acquisition owns unseen IDs. Exact trigger restriction inherits raw acquisition/cutoff only, in a new namespace; stop active scans before policy sync. First accepted corpus must use the same complete payload as later scans. Cache unchanged positive/negative judgments; inference failure must preserve baseline. `sss test` = acquisition only, no model/delivery. Live inference probe = `assessItem` on inert observations; inspect request tools/output contracts in `src/codex/inference.ts`.

Bundled reset rubrics favor recall: supply trusted account context; implicit product/timing + fresh completed resets qualify when plausible. Regression = `pnpm eval:resets [CASE…]`; live inference only, no DB/delivery. Prompt-only deployment = stop scheduler → `node scripts/upgrade-reset-rubrics.ts ID` before runtime sync → restart. Helper preserves accepted IDs/cutoff in a new namespace, isolates old judgments; unseen arrivals assess normally, accepted negatives stay quiet.

Revision keys = `input-v1:` + SHA256(key-sorted JSON projection of full ScanItem); preserve exact strings + missing/undefined JSON equivalence; exclude collection acquisition time. Data-only legacy keys refresh once in revision mode, including suppressed/positive/negative entries; positive refresh may repeat an alert. Strict-new accepted-ID guard owns the earlier branch.

X = keyword-free Latest search + case-insensitive permalink selectors + primary-author metadata verification + overlap pagination + complete permalink reads. Detail identity = canonical or exact `/history` timestamp link; strip display clocks. Parse balanced author labels/embedded avatars + handle/clock spacing; refresh thread context until it contains the fully rendered target. Structural readiness precedes authored error-phrase detection. v1/v2/v3→v4 parser upgrade inherits only compatible strict-new raw history/cutoff under existing CAS/quiescence fencing; other semantic changes re-prime. Nested self-quotes must never supply pagination overlap. Browser indexing/deletions prevent an exhaustive guarantee. Email = existing `msmtp` account + `events` filter; verify authentication without sending a message before activation.

BrowserOS discovery = read-only: verify MCP, restrict origin, navigate/read, close created tab. Scheduled calls = direct `tabs`/`navigate`/`read` only; page content must remain inert data.
