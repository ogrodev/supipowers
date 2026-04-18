---
name: consolidated-reliability-master-plan
created: 2026-04-17
sources: [AutoBE, ForgeCode]
tags: [consolidated, improvement-plan, reliability, ai, supipowers]
---

# Consolidated Reliability Improvement Plan for supipowers

## Purpose

Combine the improvement plans under `.omp/improvement-plans/AutoBE/` and `.omp/improvement-plans/ForgeCode/` into one execution order without dropping any scoped work.

## Conflict assessment

No opposing logic was found that requires a user decision.

The only real sequencing tension is this:
- ForgeCode wants behavior-level evaluation first so later work is measurable.
- AutoBE wants schema-backed contracts and deterministic validation to become the main implementation pattern.

Those are complementary, not conflicting. The consolidated plan therefore puts external behavior evals first, then lands the shared structured-output/runtime changes, then adds local telemetry, scorecards, and failure-mining once the new foundations are stable enough to measure.

## Repo grounding

This consolidation is anchored to the current repo shape verified on 2026-04-17.

Existing modules that this plan intentionally builds around:
- `src/bootstrap.ts`
- `src/planning/system-prompt.ts`
- `src/planning/approval-flow.ts`
- `src/context-mode/hooks.ts`
- `src/context-mode/tools.ts`
- `src/commands/plan.ts`
- `src/commands/ai-review.ts`
- `src/commands/qa.ts`
- `src/commands/fix-pr.ts`
- `src/commands/release.ts`
- `src/commands/status.ts`
- `src/commands/doctor.ts`
- `src/quality/ai-session.ts`
- `src/quality/ai-setup.ts`
- `src/quality/runner.ts`
- `src/review/output.ts`
- `src/review/runner.ts`
- `src/review/multi-agent-runner.ts`
- `src/review/validator.ts`
- `src/review/fixer.ts`
- `src/docs/drift.ts`
- `src/git/commit.ts`
- `src/lsp/bridge.ts`
- `src/storage/plans.ts`
- `src/storage/reports.ts`
- `src/storage/review-sessions.ts`
- `src/storage/qa-sessions.ts`
- `src/storage/fix-pr-sessions.ts`
- `src/types.ts`

Planned new modules mentioned below such as `src/ai/structured-output.ts`, `src/planning/spec.ts`, `src/discovery/`, and `src/storage/reliability-metrics.ts` do not exist yet and should be created only inside their owning phases.

## Source coverage map

This is the completeness check. Every existing source plan is represented below.

| Source document | Consolidated phase(s) |
| --- | --- |
| `AutoBE/01-structured-output-foundation.md` | Phase 1 |
| `AutoBE/02-schema-first-planning.md` | Phase 3 |
| `AutoBE/03-command-hardening.md` | Phase 5 |
| `AutoBE/04-fix-pr-and-release-phase-gating.md` | Phase 7 |
| `AutoBE/05-reliability-evaluation.md` | Phase 8 |
| `ForgeCode/01-behavior-eval-harness.md` | Phase 0 |
| `ForgeCode/02-runtime-guardrails.md` | Phase 4 |
| `ForgeCode/03-discovery-and-retrieval.md` | Phase 6 |
| `ForgeCode/04-tool-contracts-and-prompts.md` | Phase 2 |
| `ForgeCode/05-telemetry-and-failure-mining.md` | Phase 8 |
| `ForgeCode/06-qa-and-fix-pr-rollout.md` | Phase 7 |

## Consolidated execution order

### Phase 0 — behavior eval harness first

Purpose: establish behavior-level regression measurement before changing the orchestration model.

Includes:
- a dedicated `tests/evals/` workflow harness with deterministic fixtures
- eval coverage for `/supi:plan`, `/supi:review`, planning-mode question routing, context-mode high-output routing, persisted artifacts, and review rerun behavior
- shared test helpers only where they are truly needed; keep as much as possible test-local

Primary files:
- `package.json`
- `tests/evals/` (new)
- `tests/integration/` and/or `tests/helpers/`

Exit gate:
- workflow regressions fail as evals, not only as narrow unit tests
- the harness can prove artifact creation, blocking behavior, and expected completion conditions deterministically

Why first:
- this preserves ForgeCode’s requirement that the rest of the roadmap be measurable
- it does not conflict with AutoBE because it measures behavior rather than choosing an implementation pattern

### Phase 1 — shared structured-output foundation

Purpose: create one canonical, schema-backed path for AI artifacts.

Includes:
- create `src/ai/structured-output.ts` for final-assistant extraction, schema-backed parsing, retry orchestration, and blocked-result reporting
- create `src/ai/final-message.ts` and `src/ai/schema-text.ts`
- cut the existing review pipeline over to the shared helper instead of keeping review-specific extraction and retry machinery scattered across review modules
- generate prompt-visible schema text from canonical contracts rather than hand-maintaining schema prose in multiple places

Primary files:
- `src/quality/ai-session.ts`
- `src/review/output.ts`
- `src/review/runner.ts`
- `src/review/multi-agent-runner.ts`
- `src/review/validator.ts`
- `src/review/fixer.ts`
- `src/review/types.ts`
- `tests/ai/structured-output.test.ts`
- `tests/ai/schema-text.test.ts`
- review tests already covering runner/validator/fixer/multi-agent flow

Exit gate:
- review still produces the same durable artifacts and validations
- shared code owns schema parsing, retry, normalization entry points, and blocked reporting
- later workflows can reuse the foundation without copying review logic

### Phase 2 — tool contracts and prompt hardening

Purpose: make the model-facing interface easier to use correctly and harder to misuse.

Includes:
- simplify and standardize tool contracts for `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_search`, `planning_ask`, and related context-mode tooling
- remove duplicated prohibitions and bloated prompt text where runtime rules already exist
- tighten guidance in planning/review/QA/fix-pr prompts so they point to one preferred path instead of many overlapping instructions
- keep names short, concrete, and consistent with actual runtime behavior

Primary files:
- `src/context-mode/tools.ts`
- `src/bootstrap.ts`
- `src/planning/system-prompt.ts`
- `src/review/default-agents/correctness.md`
- `src/review/default-agents/maintainability.md`
- `src/review/default-agents/security.md`
- prompt builders under `src/qa/` and `src/fix-pr/`

Exit gate:
- the preferred tool path is explicit for high-output, search, and planning question scenarios
- prompt/schema drift drops because schema text now comes from Phase 1 and duplicated prose is removed
- behavior evals from Phase 0 can detect prompt/tool regressions

### Phase 3 — schema-first planning cutover

Purpose: make a validated `PlanSpec` the canonical planning artifact, with markdown rendered from it deterministically.

Includes:
- add canonical planning contracts in `src/types.ts`
- create `src/planning/spec.ts` and `src/planning/validate.ts`
- create `src/planning/render-markdown.ts`
- update `src/planning/prompt-builder.ts` so planning requests target the validated artifact first
- cut `/supi:plan`, `src/planning/approval-flow.ts`, and `src/storage/plans.ts` over to artifact-first flow

Primary files:
- `src/commands/plan.ts`
- `src/planning/prompt-builder.ts`
- `src/planning/approval-flow.ts`
- `src/planning/system-prompt.ts`
- `src/storage/plans.ts`
- `tests/planning/spec.test.ts`
- `tests/planning/validate.test.ts`
- `tests/planning/render-markdown.test.ts`
- `tests/planning/approval-flow.test.ts`
- `tests/storage/plans.test.ts`

Exit gate:
- invalid planning artifacts retry or block before approval
- markdown is rendered from `PlanSpec` and is no longer the canonical source of truth
- saved markdown can still be parsed without losing task ids, files, criteria, or complexity

### Phase 4 — runtime guardrails and completion control

Purpose: move workflow correctness from prompt wording into explicit runtime enforcement.

Includes:
- enforce artifact existence before completion
- enforce required verification before completion where the workflow requires it
- block completion when outstanding todos, pending review state, or unresolved workflow obligations still exist
- encode user-question rules by mode instead of leaving them entirely to prompt prose
- apply this first to `/supi:plan`, `/supi:review`, `/supi:qa`, and `/supi:fix-pr`

Primary files:
- `src/bootstrap.ts`
- `src/planning/approval-flow.ts`
- `src/planning/system-prompt.ts`
- `src/commands/ai-review.ts`
- `src/commands/qa.ts`
- `src/commands/fix-pr.ts`
- likely one shared module under `src/discipline/` or a small new workflow helper module

Exit gate:
- harmless prompt drift cannot cause false completion on guarded workflows
- blocked states are explicit and truthful
- evals prove that missing artifacts or skipped verification now fail correctly

### Phase 5 — command hardening for commit, docs, and AI-gated flows

Purpose: migrate the remaining smaller AI-heavy consumers off regex scraping, free-form parsing, and heuristic fallback.

Includes:
- commit planning via validated structured contracts with full staged-file coverage checks
- typed doc-drift findings instead of heuristic parsing from arbitrary prose
- canonical contracts for AI review gate, quality setup, and LSP diagnostic helper flows
- explicit blocked states instead of silent parse failure or guessed fallbacks

Primary files:
- `src/git/commit.ts`
- `src/git/commit-contract.ts`
- `src/docs/drift.ts`
- `src/docs/contracts.ts`
- `src/commands/generate.ts`
- `src/quality/gates/ai-review.ts`
- `src/quality/ai-setup.ts`
- `src/lsp/bridge.ts`
- `src/config/schema.ts`

Exit gate:
- commit plans validate that every staged file is covered exactly once
- doc-drift no longer fabricates findings by heuristic guesswork
- AI review gate / quality setup / LSP helper flows consume validated contracts and retry or block deterministically

### Phase 6 — discovery and retrieval layer

Purpose: give workflows a first-class way to find the right repo entry points quickly.

Includes:
- create `src/discovery/` with repo-root/workspace metadata, changed-file input, path-to-target mapping, and optional LSP-assisted symbol discovery
- produce ranked file candidates, ranked symbol candidates, and short rationale for why they were surfaced
- integrate discovery into `/supi:review`, quality gates, `/supi:plan`, `/supi:qa`, and `/supi:fix-pr`
- optionally reuse context-mode indexed knowledge when it improves local ranking without introducing a hosted dependency

Primary files:
- `src/discovery/` (new)
- `src/commands/ai-review.ts`
- `src/quality/runner.ts`
- `src/commands/plan.ts`
- `src/commands/qa.ts`
- `src/commands/fix-pr.ts`
- `tests/discovery/` plus workflow-specific tests

Exit gate:
- fixture workspaces rank expected files and symbols first
- workflows surface rationale, not opaque guesses
- discovery orchestrates native tools rather than competing with them

### Phase 7 — workflow rollouts: QA, fix-pr, and release phase gating

Purpose: apply the new foundation to the heaviest remaining workflows without leaving split orchestration models behind.

#### 7A — QA and fix-pr rollout

Includes:
- QA blocks truthfully when required setup/session artifacts are missing
- QA uses discovery for route/test focus
- fix-pr blocks when clustered comments for the selected target remain unresolved
- fix-pr uses discovery to narrow relevant files around comment targets
- fix-pr generates validated per-comment assessment artifacts containing verdict, rationale, affected files, ripple effects, and verification plan
- fix-pr groups work from those artifacts instead of from free-form orchestration prose

Primary files:
- `src/commands/qa.ts`
- `src/qa/config.ts`
- `src/qa/detect-app-type.ts`
- `src/qa/discover-routes.ts`
- `src/qa/prompt-builder.ts`
- `src/commands/fix-pr.ts`
- `src/fix-pr/contracts.ts`
- `src/fix-pr/assessment.ts`
- `src/fix-pr/fetch-comments.ts`
- `src/fix-pr/prompt-builder.ts`
- `src/storage/qa-sessions.ts`
- `src/storage/fix-pr-sessions.ts`

#### 7B — release phase gating

Includes:
- typed contracts for release-note polish and doc-fix subflows
- explicit phase ordering inside `/supi:release`
- blocked reporting when upstream artifacts are invalid rather than silently continuing toward publish steps

Primary files:
- `src/commands/release.ts`
- `src/release/contracts.ts`
- `src/docs/drift.ts`
- release tests and command tests

Exit gate for Phase 7:
- QA, fix-pr, and release all expose explicit phases in code
- none of them can report completion honestly without validated upstream artifacts
- the old prose-first path is removed rather than kept alive beside the new path

### Phase 8 — observability, failure mining, and local reliability scorecards

Purpose: close the loop after the new foundations land.

Includes two complementary tracks that should be treated as one reliability system:

#### 8A — local reliability metrics and scorecards
- define canonical reliability event contracts in `src/types.ts`
- create `src/storage/reliability-metrics.ts`
- instrument shared helpers and AI-heavy commands to record success, blocked, retry exhaustion, and manual fallback outcomes
- surface grounded summaries in `src/commands/status.ts` and `src/commands/doctor.ts`

#### 8B — failure mining from stored artifacts
- mine stored review/QA/fix-pr sessions and debug traces for recurring failure classes
- classify issues such as premature completion, wrong tool path, missing artifact, skipped verification, discovery miss, and unproductive retry loops
- convert recurring classes into one of: new behavior eval, new runtime guardrail, tool contract simplification, or prompt reduction

Primary files:
- `src/storage/reliability-metrics.ts`
- `src/context-mode/hooks.ts`
- `src/debug/logger.ts`
- `src/storage/review-sessions.ts`
- `src/storage/qa-sessions.ts`
- `src/storage/fix-pr-sessions.ts`
- a small offline analysis module under `src/debug/`, `src/research/`, or `src/discipline/`
- `src/commands/status.ts`
- `src/commands/doctor.ts`
- `src/storage/reports.ts`

Exit gate:
- reliability is measurable locally without a hosted telemetry service
- mined failures produce concrete new hardening work instead of staying as anecdotes
- status/doctor summaries are grounded in stored metrics, not vibes

## Parallelization guidance

Use this as the default dependency graph:
1. Phase 0 first
2. Phase 1 next
3. Phase 2 after Phase 1 starts landing
4. Phase 3 after Phase 1 is stable enough for planning to reuse it
5. Phase 4 after Phase 3, so planning guardrails reflect the new canonical artifact path
6. Phase 5 after Phase 1; it can overlap late with Phase 4 if file overlap is controlled
7. Phase 6 after Phase 0; in practice it is safest after Phases 3 through 5 because it touches the same workflows
8. Phase 7 after Phases 4 through 6
9. Phase 8 last, once the migrated workflows describe the intended steady state

This preserves the useful part of both source orderings:
- ForgeCode’s insistence on measuring behavior before broad changes
- AutoBE’s insistence on establishing a shared structured-output foundation before migrating workflow-specific consumers

## Consolidated anti-goals

Do not accidentally expand this roadmap into a different product.

- Do not rebuild supipowers as a standalone terminal agent; keep it OMP-native.
- Do not add a hosted retrieval layer, vector database requirement, or telemetry backend.
- Do not introduce a generic AI framework that outgrows the repo’s actual needs.
- Do not keep dual canonical representations alive once a cutover lands.
- Do not replace deterministic command logic with more prompt text.
- Do not add parallelism everywhere; only where the workflow genuinely benefits and remains understandable.
- Do not surface noisy user-facing dashboards before metrics are trustworthy.

## Final definition of success

The consolidation is complete only when all of these are true:
- workflow regressions are caught by behavior evals, not only by unit tests
- AI-heavy workflows consume validated artifacts or block truthfully
- `/supi:plan` uses a canonical validated plan artifact and deterministic markdown rendering
- commit, docs, AI gates, QA, fix-pr, and release no longer depend on heuristic parsing for critical decisions
- completion cannot be reported while required artifacts, verification, or unresolved work are still missing
- discovery ranks the right files and symbols early enough to improve large-repo performance materially
- tool misuse decreases because the preferred path is simple and explicit
- stored sessions and local metrics routinely produce new hardening work
- status/doctor can describe reliability with concrete numbers grounded in local storage
