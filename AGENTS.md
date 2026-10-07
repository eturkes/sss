# Alignment

## Collaboration

- Ground claims in evidence + state uncertainty. Chat = blockers + essentials for a technically proficient user.
- During exploratory work, open useful discussions: surface settled context, probe uncertainties, articulate tacit knowledge, examine options/assumptions; offer vocabulary, examples, counterexamples, tradeoffs + testable probes as useful.
- Stay objective; critique my ideas when warranted. Use deduction, first principles, scientific + Socratic methods for root causes; experiments + benchmarks must resolve material uncertainty.
- Report what failed attempts taught; revise the approach or restart when warranted.

## Execution

- Install/configure project-local; work within the launch dir + children.
- Reason, research + execute at full capability through completion; efficiency preserves required scope, depth, real success criteria + verification.
- Use planning + checkpoints when they help the task; revise them as evidence changes. Resume from conversation, working tree + git history; save only context those do not recover.
- Open tooling, method or design choices → research with available search/fetch tools + authenticated browser access where needed. Primary sources + measurements outrank popularity.
- Tooling: my preselection is authoritative; select by SOTA task/agent fit. Consider reimplementation, agent-oriented languages (agentlanguages.dev) + AI-targeted tooling; build on mature work when it is SOTA.
- Git: authorized change/build work includes all local-repo commands; I handle remote. One commit per cohesive piece, deferred mid-iteration to the closing turn; subject = `<scope>: <cause> → <fix>`, body = measurements + SHAs as payload. Keep `.gitignore` current.

## Authoring

- AI agents = sole developers. All text artifacts, durable + throwaway → agent-optimized by default: reports, notes, code/config comments, internal docs, instructions + filenames. Write dense, symbol-forward, human-sparse text using telegraphic phrasing + `→`/`=`. Compress aggressively; prune unhelpful, implicit, obsolete, redundant content + structures whenever encountered.
- State rules, facts + warnings plainly; prune provenance (dates, verification/discovery events, origin stories).
- Future-facing text, esp. prompts → state the desired action/target positively (`always`/`must`).
- Maintain task-touched instruction + skill files during authorized work; improve them when useful. Route durable guidance to one scope: global `~/.codex/AGENTS.md` = project-independent behavior + Codex environment/tooling + machine capabilities; project/scoped `AGENTS.md` = repo principles + binding rules; `.agents/skills/` = repo workflows.
- Preserve project-specific rules when refreshing templates. Conventions, stack decisions + verification entry points belong in applicable `AGENTS.md`; optional task notes hold changing state.
- UI/UX: unique fonts, cohesive colors/themes, style fitted to project + human audience.
- Human-facing surfaces (shipped README/docs, UI copy, CLI help…) → natural + direct ASD-STE100 register: ≤20 words/sentence in instructions, ≤25 in descriptions; imperative steps, one instruction per sentence, condition before command; simple tenses, finite verbs, active voice, definite modality (`must`); terminology fixed + sentence shape varied; full forms with articles + `that`; flexible enumeration; code + identifiers verbatim. Machine-consumed payloads (JSON fields, logs, codes) = code surface.

## Engineering

- Elegant, tightly-scoped modular components; deduplicate; KISS + UNIX where apt; refactor proactively.
- Code → concise, performant, bug-free + maximally agent-legible; use idioms where they serve those bounds.
- Comments explain the constraint, measurement or upstream quirk behind a peculiar decision; code states the `what`.
- Use established methods (TDD red-green-refactor, differential oracles, adversarial review) + alternatives with measured advantage over the default.
- Within required verification scope, deterministic checks own tool-decidable rules: linters, type checkers, static analysis, formatters, schema/contract validators; judgment passes cover the remainder. Configure + extend proven checkers first; uncovered required invariant → dedicated check wired into the gate.
- Tests/verification: scope = requested outcome + regression risk + repo posture. Reversible edits with low impact → direct checks; add tests only when meaningful + necessary to verify behavior independently of implementation. Fuzzing/property/formal methods require a task-specific advantage.
- Complete appropriate tests + required checks, then finish delivery. Repeat/broaden verification only for new changes, failures or unresolved concerns; focus checks on that evidence.
- A gate backing a durable claim must rerun from committed state. Keep its implementation or complete regeneration recipe + invocation in tracked code, skills or docs; applicable `AGENTS.md` points to the entry point.
- Generated-artifact repairs → one idempotent script replayable from a clean base; prove byte-identical output by rerunning.
- Adversarial review (code or session) → scrutinize correctness + logic, claim soundness, guarantee-vs-claim gaps; weigh honesty + overreach above style. Report every issue, incl. uncertain/low-severity; I filter findings.
- Fix the review check set before reading the diff. Completion = every row adjudicated + row count/table delivered; all-`pass` is complete. Bind findings/fixes to the reviewed change + adjudicated rows; report outside issues as deferred items. Accepted rulings hold until new evidence reverses them; each fix gets one re-review against that finding's check alone.
- Remotely-exploitable code → highest security standard: periodically audit, update software to latest, verify behavior after.

## SSS

- Stack = TypeScript ESM; Node `>=24.15 <27` executes `.ts` + `node:sqlite` directly; pnpm 11. Version pins = `package.json` + `pnpm-lock.yaml`; install = `pnpm install --frozen-lockfile`.
- Contract = `src/config/schema.ts`; YAML loading = `src/config/load.ts`; operator documentation = `README.md`; recipe/adapter workflow = `.agents/skills/sss/SKILL.md`.
- Scheduled acquisition must stay deterministic. Codex = isolated recipe compiler + tool-free `gpt-6.1-sol`/`xhigh` assessment through `src/codex/inference.ts`; X → BrowserOS Neo `127.0.0.1:9200/mcp`; legacy `browseros` → fixed compatibility `127.0.0.1:9000/mcp`; allowlisted direct `tabs`/`navigate`/`read`. Acquired content must remain inert data; model judgments = qualified observations, not confirmed predictions. Assessment media = bounded/signature-validated HTTPS `pbs.twimg.com/media/` images, no redirects/model-controlled retrieval.
- Events must describe observations, not publication-time or market-wide truth. Invalid/incomplete/incomparable acquisition must preserve the last accepted baseline; valid zero-result queries require explicit `allowEmpty`.
- Source/extraction/assertion/rule semantics own isolated state namespaces. Preserve fencing for monitor claims, scan attempts + delivery completion; superseded workers must not commit.
- Gate = `pnpm check` (strict TypeScript) + `pnpm test` (serial Node fixture suite); rerun from committed state. Coverage inspection = `pnpm test:coverage`; no coverage threshold exists. Preserve existing cases + assertions.
- Recipe validation = `pnpm sss validate ID|PATH` (offline schema/policy) → `pnpm sss test ID|PATH` (acquisition dry run). Fixture tests must stay external-service-free; live recipe checks require source access + must not deliver alerts.
- X reset monitor = `monitors/thsottiaux-codex-reset.yaml`; first complete corpus suppressed; own text + frozen parent/quote context; pagination must reach accepted primary-post overlap. Extraction semantics → increment X `adapterVersion` in `effectiveSource`; metadata clocks must never change assessment revisions. Search indexing/deletions + untranscribed video constrain coverage. Email = `msmtp` account; notification `events` selects delivery kinds. Service writable targets = state/recipes + Codex/Gmail OAuth refresh stores.
