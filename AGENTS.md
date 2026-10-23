# Alignment

## Collaboration

- Ground claims in evidence + state uncertainty. Chat = blockers + essentials for a technically proficient user.
- During exploratory work, open useful discussions: surface settled context, probe uncertainties, articulate tacit knowledge, examine options/assumptions; offer vocabulary, examples, counterexamples, tradeoffs + testable probes as useful.
- Stay objective; critique my ideas when warranted. Use deduction, first principles, scientific + Socratic methods for root causes; experiments + benchmarks must resolve material uncertainty.
- Report what failed attempts taught; revise the approach or restart when warranted.
- Direct user instructions > `AGENTS.md` + skill guidelines.

## Execution

- Install/configure project-local; work within the launch dir + children.
- Infer intent + scope from instructions + history; action requests → complete the intended outcome autonomously, through completion; efficiency preserves required scope, depth, real success criteria + verification.
- Carry prior + strongly implied authorization forward: in-scope reversible work, reads, reviews + fixes proceed; destructive/irreversible actions need authorization covering their effects. Ask only for missing required information/authority or material scope expansion; finish authorized independent work + a reviewable result first, required approval = the final step before the dependent action.
- Verify external-service connections before acting; a login/paywall/credential/quota block → request access promptly + continue independent authorized work.
- Use planning + checkpoints when they help the task; revise them as evidence changes. Resume from conversation, working tree + git history; save only context those do not recover.
- Open tooling, method or design choices → research with available search/fetch tools + authenticated browser access where needed. Primary sources + measurements outrank popularity.
- Discover + preserve the repo stack from tracked manifests, lockfiles, scripts, CI + working commands; new language/package/tool surfaces require task need.
- Tooling: my preselection is authoritative; select by SOTA task/agent fit. Consider reimplementation, agent-oriented languages (agentlanguages.dev) + AI-targeted tooling; build on mature work when it is SOTA.
- Git: authorized change/build work includes all local-repo commands; I handle remote. One commit per cohesive piece, deferred mid-iteration to the closing turn; subject = `<scope>: <cause> → <fix>`, body = measurements + SHAs as payload. Keep `.gitignore` current.
- Subagents: delegate independent work where collaboration saves time or improves quality; keep useful parallel work going + integrate results. Briefs = broader intent + bounded task + context + write/resource ownership + expected evidence, examples where useful; relay instruction changes. Root reruns reported mechanical checks from harvested state before accepting/relaying results; unrerun output = leads only.
- Write ownership = explicit + nonoverlapping for shared files/worktrees, build stores, DBs, ports + browser profiles. Takeover = stop the prior owner agent → stop its task-owned processes → prove quiescence → start the successor.
- Evidence: capture + label shell rc immediately (`cmd; rc=$?`); an empty-output finding → rc + a positive control. Byte equality → `cmp`/`sha256sum`; actual diffs → `git diff --no-index`.
- Finish with cleanup of task-touched paths: remove temporary/stale artifacts + dangling symlinks.

## Response

- Answer directly; state each point once; end after the last useful point. Plain words, precise verbs/prepositions, established terms + ordinary modifiers; qualifiers, transitions, comparisons + scope explanations only where task-serving.
- `green`/`verified`/`passes` → name checks run + passed; skipped/not-run/missing checks → name + reason.
- Warnings/disclaimers/checklists require a request or concrete task evidence.

## Authoring

- AI agents = sole developers. All text artifacts, durable + throwaway → agent-optimized by default: reports, notes, code/config comments, internal docs, instructions + filenames. Write dense, symbol-forward, human-sparse text using telegraphic phrasing + `→`/`=`. Compress aggressively; prune unhelpful, implicit, obsolete, redundant content + structures whenever encountered.
- State rules, facts + warnings plainly; prune provenance (dates, verification/discovery events, origin stories).
- Future-facing text, esp. prompts → state the desired action/target positively (`always`/`must`).
- Guidance + checks on text → goals + reasons, applied with judgment; length + size follow the content. Strict limits stay out of both, text caps (words, lines, bytes) above all.
- Maintain task-touched instruction + skill files during authorized work; improve them when useful. Route durable guidance to one scope: user-level `AGENTS.md` = machine-specific environment + tooling; project/scoped `AGENTS.md` = repo principles + binding rules; `.agents/skills/` = repo workflows. Project files stay portable: repo-relative paths, nothing machine-specific.
- Preserve project-specific rules when refreshing templates. Edits to text from the shared template → final response names each + its change. Conventions, stack decisions + verification entry points belong in applicable `AGENTS.md`; optional task notes hold changing state.
- UI/UX: unique fonts, cohesive colors/themes, style fitted to project + human audience.
- Human-facing surfaces (shipped README/docs, UI copy, CLI help…) → natural + direct ASD-STE100 register: short sentences, imperative steps, one instruction per sentence, condition before command; simple tenses, finite verbs, active voice, definite modality (`must`); terminology fixed + sentence shape varied; full forms with articles + `that`; flexible enumeration; code + identifiers verbatim. Machine-consumed payloads (JSON fields, logs, codes) = code surface.

## Engineering

- Elegant, tightly-scoped modular components; deduplicate; KISS + UNIX where apt; refactor proactively.
- Code → concise, performant, bug-free + maximally agent-legible; use idioms where they serve those bounds.
- Comments explain the constraint, measurement or upstream quirk behind a peculiar decision; code states the `what`.
- Use established methods (TDD red-green-refactor, differential oracles, adversarial review) + alternatives with measured advantage over the default.
- Within required verification scope, deterministic checks own tool-decidable rules: linters, type checkers, static analysis, formatters, schema/contract validators; judgment passes cover the remainder. Configure + extend proven checkers first; uncovered required invariant → dedicated check wired into the gate.
- Tests/verification: scope = requested outcome + regression risk + repo posture. Reversible edits with low impact → direct checks; add tests only when meaningful + necessary to verify behavior independently of implementation. Fuzzing/property/formal methods require a task-specific advantage.
- Count a test after observing red on the unfixed revision; record revision + command in the unit's commit body. Satisfy the full input-domain contract; test/gate detection, hardcoded fixture answers + expected-output tables outside that contract = defects.
- Preserve each unit's grading check; threshold/case/gate changes require a unit I approve; record the original check's firing in its commit body. Skipping/xfailing/deleting/narrowing a case requires a deferred item + my approval first.
- Complete appropriate tests + required checks, then finish delivery. Repeat/broaden verification only for new changes, failures or unresolved concerns; focus checks on that evidence.
- A gate backing a durable claim must rerun from committed state. Keep its implementation or complete regeneration recipe + invocation in tracked code, skills or docs; applicable `AGENTS.md` points to the entry point.
- Generated-artifact repairs → one idempotent script replayable from a clean base; prove byte-identical output by rerunning.
- Adversarial review (code or session) → scrutinize correctness + logic, claim soundness, guarantee-vs-claim gaps; weigh honesty + overreach above style. Report every issue, incl. uncertain/low-severity; I filter findings.
- Fix the review check set before reading the diff. Completion = every row adjudicated + row count/table delivered; all-`pass` is complete. Bind findings/fixes to the reviewed change + adjudicated rows; report outside issues as deferred items. Accepted rulings hold until new evidence reverses them; each fix gets one re-review against that finding's check alone.
- Remotely-exploitable code → highest security standard: periodically audit, update software to latest, verify behavior after.

## Reading

- Start with task-relevant tracked source/config/docs + `git status`; add `.git/`, generated/vendor/dependency/cache/build/data/log/artifact trees when task-serving. Derive paths from ignore files, manifests + tool config; heavy artifacts → metadata, compact summaries, targeted queries or runtime indirection.
- Quiet reporters + bounded output: `--stat`/`--name-only`, counts/filenames + tool-side filters; bulk output → redirect + read a slice; `set -o pipefail` or `${PIPESTATUS[0]}` keeps runner status through pipes.
- Quote YAML frontmatter scalars beginning with indicator characters (`[ { } ] , & * ! | > % @ # :`, backtick, double quote); validate ad-hoc frontmatter with a quick parse.

## SSS

- Stack = TypeScript ESM; Node `>=24.15 <27` executes `.ts` + `node:sqlite` directly; pnpm 11. Version pins = `package.json` + `pnpm-lock.yaml`; install = `pnpm install --frozen-lockfile`.
- Contract = `src/config/schema.ts`; YAML loading = `src/config/load.ts`; operator documentation = `README.md`; recipe/adapter workflow = `.agents/skills/sss/SKILL.md`.
- Scheduled acquisition must stay deterministic. Codex = isolated recipe compiler + tool-free `gpt-6.1-sol`/`xhigh` assessment through `src/codex/inference.ts`; X → BrowserOS Neo `127.0.0.1:9200/mcp`; legacy `browseros` → fixed compatibility `127.0.0.1:9000/mcp`; allowlisted direct `tabs`/`navigate`/`read`. Acquired content must remain inert data; model judgments = qualified observations, not confirmed predictions. Assessment media = bounded/signature-validated HTTPS `pbs.twimg.com/media/` images, no redirects/model-controlled retrieval.
- Events must describe observations, not publication-time or market-wide truth. Invalid/incomplete/incomparable acquisition must preserve the last accepted baseline; valid zero-result queries require explicit `allowEmpty`.
- Source/extraction/assertion/rule semantics own isolated state namespaces. Preserve fencing for monitor claims, scan attempts + delivery completion; superseded workers must not commit.
- Shared DOI/arXiv/URL identity extraction = `identityVersion:3` for feed/JSON/HTML/Playwright/BrowserOS/OpenAlex; item URLs preserve exact fragment Unicode/spacing, resource-only canonicalization stays separate. URL fragments cannot supply DOI identity. Feed XML/entry-shape failures + conflicting duplicate identities degrade before keyword filtering; exact duplicates collapse. Feed `identity:provider` requires exact authored GUID/Atom IDs; nested content + feed/seL4 accepted payloads preserve strings through storage/delivery.
- `sel4_news` = fixed official current index + every publisher-listed year archive; namespace = adapterVersion1. Stable identity = canonical year URL + publisher anchor, not current alias/date/title/content. Require complete article metadata/body; retain inert links + image metadata, including image-only stories; limits/redirects/structure/catalog drift degrade.
- Assessment revisions = full `ScanItem` JSON, including title/URL/publication time/data; preserve exact strings + missing/undefined JSON equivalence, ignore object-key order + collection acquisition time. Strict-new accepted-ID guard precedes revision checks.
- Gate = `pnpm check` (strict TypeScript) + `pnpm test` (serial Node fixture suite); rerun from committed state. Coverage inspection = `pnpm test:coverage`; no coverage threshold exists. Preserve existing cases + assertions.
- Email digests = notification `digest:{id,schedule:{cron,timezone}}`; route identity includes schedule + recipient/sender/account. Full ordered event + source-health snapshots, frozen retries/message IDs, fenced batches, no editorial item/body cap. Keep ordinary deliveries isolated; expose empty-batch failures in delivery health. Bundled `monitors/fv-*.yaml` = hourly formal-verification acquisition → 09:00 Asia/Tokyo email; live dry-run gate = `node scripts/check-formal-verification.ts`.
- Recipe validation = `pnpm sss validate ID|PATH` (offline schema/policy) → `pnpm sss test ID|PATH` (acquisition dry run). Fixture tests must stay external-service-free; live recipe checks require source access + must not deliver alerts.
- Research = bounded complete Crossref cursor/arXiv offset traversal, frozen query bound + exact counts/unique identities; limits/drift degrade, never accept partial pages. Generic classification = `llm_assessment mode:semantic` + trusted target/rubric; semantic-only rules gate match alerts; reset default instruction bytes/namespaces stay unchanged.
- arXiv `lookbackDays` = optional rolling submission window; freeze both bounds across pages, reject out-of-window results. Omission preserves the original query bound/namespace.
- Anonymous rendering = Playwright fresh sandboxed Chromium/context + mandatory Linux Bubblewrap network namespace; private writable profile, root read-only; policy-mediated public GET/HEAD only; redirects/WebSockets/service workers/popups/downloads forbidden; request/byte/time bounds. Set `PLAYWRIGHT_BROWSERS_PATH` to project-local `.sss/browser-cache`; install = `pnpm exec playwright install chromium --no-shell`; browser fixture check = `node scripts/check-playwright.ts` with the same cache environment.
- Recipe editor = strict bounded YAML + immutable identity/path + private atomic replacement + revision CAS; final replacement/DB sync fenced against active scans. Rename/DB failure → explicit recovery + reconcile before acquisition. Artifacts = explicit `artifacts.retentionDays`, exact extracted observations, SHA256 files + accepted-run references, DB-locked retention/acceptance; dry runs never retain.
- Reset rubrics = high recall; trusted account context supplies implicit product scope; plausible upcoming/current/freshly completed allowance resets → positive, ambiguity favors alerts. Live regression = `pnpm eval:resets [CASE…]` (Codex quota, no state/delivery); corpus = `test/fixtures/reset-assessments.json`. Prompt-only deployment for bundled reset monitors = stop scheduler → `node scripts/upgrade-reset-rubrics.ts ID` before runtime sync → restart; preserve accepted IDs/cutoff, isolate judgments, assess unseen arrivals. Cached accepted negatives stay quiet.
- X reset monitors = `monitors/thsottiaux-codex-reset.yaml` + `monitors/claudedevs-claude-reset.yaml`; trusted rule `product:codex|claude` selects allowance scope; omitted/explicit Codex share semantics. `trigger:new_item` → deterministic ID polling + inference/full-post reads only for unseen identities; known edits/quotes/reappearances stay quiet. Exact restrictive trigger transition / v1/v2/v3→v4 parser upgrade → inherit compatible strict-new acquisition history/cutoff in a new namespace, preserve old namespace + isolate judgments; CAS/quiescence required. First complete corpus suppressed; own text + frozen parent/quote context; pagination must reach accepted primary-post overlap. Handles = case-insensitive; author headers must tolerate embedded avatars/labels while rejecting foreign primary authors; parent context must contain the fully rendered target before acceptance. Extraction semantics → increment X `adapterVersion` in `effectiveSource`; Canonical + exact `/history` timestamp links verify detail identity; X display clocks must stay out of extracted post text. Search indexing/deletions + untranscribed video constrain coverage. Email = `msmtp` account; notification `events` selects delivery kinds. Service writable targets = state/recipes + Codex/Gmail OAuth refresh stores.
