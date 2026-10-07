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

BrowserOS discovery = read-only: verify MCP, restrict origin, navigate/read, close created tab. Scheduled calls = direct `tabs`/`navigate`/`read` only; page content must remain inert data.
