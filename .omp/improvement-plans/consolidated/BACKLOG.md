---
name: consolidated-reliability-backlog
created: 2026-04-17
sources: [AutoBE, ForgeCode]
tags: [consolidated, backlog, reliability, ai, supipowers]
---

# Consolidated Reliability Backlog for supipowers

## Purpose

Turn `.omp/improvement-plans/consolidated/README.md` into a concrete, dependency-ordered execution backlog.

Every task in this file is derived directly from the phase breakdown in `README.md`. Nothing from the source plans under `../AutoBE/` and `../ForgeCode/` is dropped.

## How to read this file

- Tasks are ordered by execution dependency.
- Each task has a stable ID (e.g. `P1-02`) that later work can reference.
- `Files` lists the exact paths the task will touch. `(new)` means the task creates the file; `(modify)` means it changes an existing file. Every path was verified against the repo on 2026-04-17.
- `Criteria` are testable conditions. A task is done only when every listed condition holds.
- `Verification` is the minimum command the agent must run before marking the task complete. Every task also implicitly depends on `bun run typecheck` staying green for the changed surface.
- `Depends on` lists the task IDs that must land first. Tasks without `Depends on` can start whenever their phase begins.
- Complexity uses the planning skill vocabulary: `small` | `medium` | `large`.

## Dependency overview

```
P0 ──► P1 ──► P2 ─┐
         │        │
         ├► P3 ──► P4 ──► P7A ─┐
         │                     │
         └► P5 ──► P6 ─────────┤
                               ├► P8A ──► P8B
                          P7B ─┘
```

| Phase | Scope | Source documents |
| --- | --- | --- |
| P0 | Behavior eval harness | `ForgeCode/01-behavior-eval-harness.md` |
| P1 | Shared structured-output foundation | `AutoBE/01-structured-output-foundation.md` |
| P2 | Tool contracts and prompt hardening | `ForgeCode/04-tool-contracts-and-prompts.md` |
| P3 | Schema-first planning cutover | `AutoBE/02-schema-first-planning.md` |
| P4 | Runtime guardrails and completion control | `ForgeCode/02-runtime-guardrails.md` |
| P5 | Command hardening for commit, docs, AI gates | `AutoBE/03-command-hardening.md` |
| P6 | Discovery and retrieval layer | `ForgeCode/03-discovery-and-retrieval.md` |
| P7A | QA + fix-pr rollout | `ForgeCode/06-qa-and-fix-pr-rollout.md`, `AutoBE/04-fix-pr-and-release-phase-gating.md` (tasks 1, 3) |
| P7B | Release phase gating | `AutoBE/04-fix-pr-and-release-phase-gating.md` (tasks 2, 3) |
| P8A | Local reliability metrics and scorecards | `AutoBE/05-reliability-evaluation.md` |
| P8B | Failure mining | `ForgeCode/05-telemetry-and-failure-mining.md` |

---

## Phase 0 — Behavior eval harness

Depends on: none. This phase must ship first so every later phase can prove it works behaviorally.

### P0-01 — Bun eval harness scaffold

- **files**:
  - Create: `tests/evals/harness.ts`
  - Create: `tests/evals/fixtures.ts`
  - Create: `tests/evals/README.md`
  - Modify: `package.json`
- **criteria**:
  - `bun run test:evals` executes evals separately from the unit-test runner
  - fixture format supports: starting command/input, available platform capabilities, expected tool/hook usage, expected files or persisted artifacts, expected completion or blocking conditions
  - harness surfaces diagnostic failure messages that name the invariant that broke
  - `tests/evals/README.md` documents how to add a new eval
- **complexity**: medium
- **verification**: `bun run test:evals` (passes with zero-or-more evals registered)

### P0-02 — Seed eval: `plan-saves-and-stops`

- **files**:
  - Create: `tests/evals/plan-saves-and-stops.test.ts`
- **criteria**:
  - eval fails when `/supi:plan` finishes without writing a plan under `.omp/supipowers/plans/`
  - eval fails when `/supi:plan` continues executing past the save boundary
- **complexity**: small
- **depends on**: P0-01
- **verification**: `bun run test:evals --filter plan-saves-and-stops`

### P0-03 — Seed eval: `plan-uses-planning-ask`

- **files**:
  - Create: `tests/evals/plan-uses-planning-ask.test.ts`
- **criteria**:
  - eval fails if planning mode invokes `ask` instead of `planning_ask`
- **complexity**: small
- **depends on**: P0-01
- **verification**: `bun run test:evals --filter plan-uses-planning-ask`

### P0-04 — Seed eval: `context-mode-routes-large-output`

- **files**:
  - Create: `tests/evals/context-mode-routes-large-output.test.ts`
- **criteria**:
  - eval fails if high-output work reaches Bash, Grep, Find, or WebFetch instead of the `ctx_*` tools when context-mode is active
- **complexity**: small
- **depends on**: P0-01
- **verification**: `bun run test:evals --filter context-mode-routes-large-output`

### P0-05 — Seed eval: `review-validates-before-report`

- **files**:
  - Create: `tests/evals/review-validates-before-report.test.ts`
- **criteria**:
  - eval fails if `/supi:review` emits final findings before the validation stage runs
- **complexity**: small
- **depends on**: P0-01
- **verification**: `bun run test:evals --filter review-validates-before-report`

### P0-06 — Seed eval: `review-rerun-loop`

- **files**:
  - Create: `tests/evals/review-rerun-loop.test.ts`
- **criteria**:
  - eval fails if review does not rerun after fixes when a rerun was requested
- **complexity**: small
- **depends on**: P0-01
- **verification**: `bun run test:evals --filter review-rerun-loop`

**Phase 0 exit gate**: five seed evals pass on main, each fails on its intended regression class, and the harness is documented so later phases can add evals without inventing new patterns.

---

## Phase 1 — Shared structured-output foundation

Depends on: P0-01 (so we can regression-test the foundation behaviorally).

### P1-01 — Extract generic structured-output execution helpers

- **files**:
  - Create: `src/ai/structured-output.ts`
  - Create: `src/ai/final-message.ts`
  - Create: `tests/ai/structured-output.test.ts`
  - Modify: `src/quality/ai-session.ts`
  - Modify: `src/review/output.ts`
  - Create: `tests/review/output.test.ts`
- **criteria**:
  - one shared module owns final-assistant extraction, schema-backed parsing, retry orchestration, and blocked-result reporting
  - review-specific code keeps only review-specific schemas and normalization
  - no other consumer needs to invent its own JSON extraction, retry, or blocked-result handling
- **complexity**: large
- **depends on**: P0-01
- **verification**: `bun test tests/ai/structured-output.test.ts tests/review/output.test.ts && bun run typecheck`

### P1-02 — Canonical schema-to-prompt rendering

- **files**:
  - Create: `src/ai/schema-text.ts`
  - Create: `tests/ai/schema-text.test.ts`
  - Modify: `src/review/types.ts`
  - Modify: `src/review/runner.ts`
  - Modify: `src/review/multi-agent-runner.ts`
  - Modify: `src/review/validator.ts`
  - Modify: `src/review/fixer.ts`
  - Create: `tests/review/runner.test.ts`
- **criteria**:
  - review prompt schema text is generated from canonical contract definitions via one shared renderer
  - a single contract change updates every prompt-visible schema through one code path
  - no duplicated schema prose remains in review modules
- **complexity**: medium
- **depends on**: P1-01
- **verification**: `bun test tests/ai/schema-text.test.ts tests/review/runner.test.ts && bun run typecheck`

### P1-03 — Cut review pipeline over to shared foundation

- **files**:
  - Modify: `src/review/output.ts`
  - Modify: `src/review/runner.ts`
  - Modify: `src/review/multi-agent-runner.ts`
  - Modify: `src/review/validator.ts`
  - Modify: `src/review/fixer.ts`
  - Create: `tests/review/validator.test.ts`
  - Create: `tests/review/fixer.test.ts`
  - Modify: `tests/review/multi-agent-runner.test.ts`
- **criteria**:
  - review produces the same durable artifacts and validations as before
  - shared infrastructure owns parsing, retry, normalization entry points, and blocked reporting
  - no review-local copy of those responsibilities remains
  - P0-05 and P0-06 still pass
- **complexity**: medium
- **depends on**: P1-01, P1-02
- **verification**: `bun test tests/review/ && bun run test:evals --filter review && bun run typecheck`

**Phase 1 exit gate**: the review pipeline works end-to-end through the shared foundation; any new AI consumer can reuse it without copying review logic.

---

## Phase 2 — Tool contracts and prompt hardening

Depends on: P1-02 (so prompt schema text comes from the canonical renderer, not hand-maintained prose).

### P2-01 — Simplify and standardize high-value tool contracts

- **files**:
  - Modify: `src/context-mode/tools.ts`
  - Modify: `src/bootstrap.ts`
  - Modify: `tests/context-mode/tools.test.ts`
- **criteria**:
  - `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_search`, `planning_ask`, and `mcpc_manager` schemas use flat shapes, consistent naming, and explicit required fields
  - every audited tool description states when to use it and when not to
  - no required field is accidentally removed
- **complexity**: medium
- **depends on**: P1-01
- **verification**: `bun test tests/context-mode/ tests/platform/ && bun run typecheck`

### P2-02 — Tighten orchestration prompts and remove duplicated prohibitions

- **files**:
  - Modify: `src/planning/system-prompt.ts`
  - Modify: `src/review/default-agents/correctness.md`
  - Modify: `src/review/default-agents/maintainability.md`
  - Modify: `src/review/default-agents/security.md`
  - Modify: `src/qa/prompt-builder.ts`
  - Modify: `src/fix-pr/prompt-builder.ts`
- **criteria**:
  - schema text referenced by prompts comes from P1-02 (no hand-maintained schema prose)
  - duplicated prohibitions already enforced by runtime rules are removed
  - every remaining instruction is a concrete directive, not motivational prose
  - hard gates stay intact
- **complexity**: medium
- **depends on**: P1-02, P2-01
- **verification**: `bun test tests/planning/ tests/review/ tests/qa/ tests/fix-pr/ && bun run test:evals && bun run typecheck`

### P2-03 — Add rendering tests for prompt builders

- **files**:
  - Modify: `tests/planning/system-prompt.test.ts`
  - Modify: `tests/qa/prompt-builder.test.ts`
  - Modify: `tests/fix-pr/prompt-builder.test.ts`
- **criteria**:
  - prompt builders have deterministic rendering coverage so future edits are reviewable
  - tests assert that required hard gates are present and that removed prohibitions are actually removed
- **complexity**: small
- **depends on**: P2-02
- **verification**: `bun test tests/planning/ tests/qa/ tests/fix-pr/`

**Phase 2 exit gate**: preferred tool path is explicit for high-output, search, and planning question scenarios; prompt/schema drift drops because the canonical renderer is the only source of schema text; evals from Phase 0 still pass with the tightened prompts.

---

## Phase 3 — Schema-first planning cutover

Depends on: P1 (the shared structured-output foundation must be ready before planning consumes it).

### P3-01 — Canonical planning contracts and validation

- **files**:
  - Modify: `src/types.ts`
  - Create: `src/planning/spec.ts`
  - Create: `src/planning/validate.ts`
  - Modify: `src/planning/prompt-builder.ts`
  - Create: `tests/planning/spec.test.ts`
  - Create: `tests/planning/validate.test.ts`
- **criteria**:
  - planning defines one typed `PlanSpec` artifact for context, tasks, complexity, file lists, and acceptance criteria
  - invalid artifacts are rejected before rendering or approval
  - the planning prompt-builder consumes the canonical schema through P1-02, not hand-maintained prose
- **complexity**: large
- **depends on**: P1-01, P1-02
- **verification**: `bun test tests/planning/spec.test.ts tests/planning/validate.test.ts && bun run typecheck`

### P3-02 — Deterministic markdown renderer and round-trip parser

- **files**:
  - Create: `src/planning/render-markdown.ts`
  - Modify: `src/storage/plans.ts`
  - Modify: `tests/storage/plans.test.ts`
  - Create: `tests/planning/render-markdown.test.ts`
- **criteria**:
  - markdown is generated from `PlanSpec` through one renderer
  - `src/storage/plans.ts` parses rendered markdown without losing task ids, names, files, criteria, or complexity
  - round-trip tests prove renderer and parser stay aligned
- **complexity**: medium
- **depends on**: P3-01
- **verification**: `bun test tests/storage/plans.test.ts tests/planning/render-markdown.test.ts && bun run typecheck`

### P3-03 — Cut `/supi:plan` and approval flow over to schema-first artifacts

- **files**:
  - Modify: `src/commands/plan.ts`
  - Modify: `src/planning/approval-flow.ts`
  - Modify: `src/planning/system-prompt.ts`
  - Modify: `src/storage/plans.ts`
  - Create: `tests/commands/plan.test.ts`
  - Modify: `tests/planning/approval-flow.test.ts`
- **criteria**:
  - plan generation retries or blocks on invalid `PlanSpec` output
  - saved markdown is rendered from the validated artifact only
  - approval flow executes the saved markdown without rebuilding task structure from ad-hoc prose
  - no dual canonical representation remains alive
  - P0-02 still passes
- **complexity**: large
- **depends on**: P3-01, P3-02
- **verification**: `bun test tests/commands/plan.test.ts tests/planning/approval-flow.test.ts tests/storage/plans.test.ts && bun run test:evals --filter plan && bun run typecheck`

**Phase 3 exit gate**: invalid planning artifacts retry or block before approval; markdown is rendered from `PlanSpec` and is no longer canonical.

---

## Phase 4 — Runtime guardrails and completion control

Depends on: P3-03 (planning is the first consumer of the guardrail layer, so the schema-first cutover must land first). Phase 4 can run in parallel with later phases once P4-01 exists.

### P4-01 — Shared workflow-invariant completion blocker

- **files**:
  - Create: `src/discipline/workflow-invariants.ts`
  - Create: `tests/discipline/workflow-invariants.test.ts`
  - Modify: `src/types.ts`
- **criteria**:
  - shared module exposes invariant-check and blocked-reason contracts
  - user-visible status text truthfully names the missing condition
  - blocker mechanism can inject continuation reminders or refuse to mark the workflow complete
  - module is generic enough to be reused by planning, review, QA, and fix-pr without each workflow reinventing the pattern
- **complexity**: large
- **depends on**: P3-03
- **verification**: `bun test tests/discipline/workflow-invariants.test.ts && bun run typecheck`

### P4-02 — Wire guardrails into `/supi:plan`

- **files**:
  - Modify: `src/planning/approval-flow.ts`
  - Modify: `src/planning/system-prompt.ts`
  - Modify: `src/commands/plan.ts`
  - Modify: `tests/planning/approval-flow.test.ts`
  - Modify: `tests/commands/plan.test.ts`
- **criteria**:
  - planning cannot finish successfully without a saved plan artifact
  - outstanding todos block completion through the invariant layer, not prompt prose
  - P0-02 remains green
- **complexity**: small
- **depends on**: P4-01
- **verification**: `bun test tests/planning/approval-flow.test.ts tests/commands/plan.test.ts && bun run test:evals --filter plan`

### P4-03 — Wire guardrails into `/supi:review`

- **files**:
  - Modify: `src/commands/ai-review.ts`
  - Modify: `tests/commands/ai-review.test.ts`
- **criteria**:
  - review with findings cannot skip the validation stage
  - pending review state blocks completion with a truthful blocker message
  - P0-05 and P0-06 remain green
- **complexity**: medium
- **depends on**: P4-01
- **verification**: `bun test tests/commands/ai-review.test.ts && bun run test:evals --filter review`

### P4-04 — Wire guardrails into `/supi:qa`

- **files**:
  - Modify: `src/commands/qa.ts`
  - Modify: `tests/commands/qa.test.ts`
- **criteria**:
  - QA blocks truthfully when required setup/session artifacts are missing
  - QA does not report readiness without an explicit verified artifact path
- **complexity**: small
- **depends on**: P4-01
- **verification**: `bun test tests/commands/qa.test.ts`

### P4-05 — Wire guardrails into `/supi:fix-pr`

- **files**:
  - Modify: `src/commands/fix-pr.ts`
  - Modify: `tests/commands/fix-pr.test.ts`
- **criteria**:
  - fix-pr blocks completion while clustered comments for the selected target remain unresolved
  - blocker message names which comments still need resolution
- **complexity**: small
- **depends on**: P4-01
- **verification**: `bun test tests/commands/fix-pr.test.ts`

### P4-06 — Encode user-question rules by mode

- **files**:
  - Modify: `src/bootstrap.ts`
  - Modify: `src/planning/system-prompt.ts`
  - Modify: `src/context-mode/hooks.ts`
  - Modify: `tests/context-mode/hooks.test.ts`
- **criteria**:
  - mode-specific user-question behavior is enforced by hook/runtime rules instead of relying on prompt prose alone
  - workflows meant to stay autonomous avoid unnecessary user questions
  - P0-03 continues to pass
- **complexity**: medium
- **depends on**: P4-01
- **verification**: `bun test tests/context-mode/ tests/planning/ && bun run test:evals --filter planning-ask`

**Phase 4 exit gate**: harmless prompt drift cannot cause false completion on guarded workflows; blocked states are explicit and truthful; evals prove missing artifacts or skipped verification fail correctly.

---

## Phase 5 — Command hardening for commit, docs, and AI-gated flows

Depends on: P1-01 (shared structured-output foundation). P5 can run in parallel with P3 and P4 as long as file overlap is controlled — `src/docs/drift.ts` is touched again later in P7B, so sequence accordingly.

### P5-01 — Migrate commit planning to shared structured-output contracts

- **files**:
  - Modify: `src/git/commit.ts`
  - Create: `src/git/commit-contract.ts`
  - Modify: `tests/git/commit.test.ts`
- **criteria**:
  - commit planning uses the shared structured-output helper from P1-01
  - every staged file is covered exactly once by the validated commit plan
  - invalid plans retry automatically; manual entry only triggers after the structured path is exhausted
- **complexity**: medium
- **depends on**: P1-01
- **verification**: `bun test tests/git/commit.test.ts && bun run typecheck`

### P5-02 — Replace doc-drift regex and heuristic parsing with typed findings

- **files**:
  - Modify: `src/docs/drift.ts`
  - Modify: `src/commands/generate.ts`
  - Create: `src/docs/contracts.ts`
  - Modify: `tests/docs/drift.test.ts`
  - Modify: `tests/commands/generate.test.ts`
- **criteria**:
  - doc-drift findings are parsed and validated against a canonical schema
  - invalid outputs retry with feedback
  - unparseable prose no longer turns into synthetic drift findings by heuristic guess
- **complexity**: large
- **depends on**: P1-01
- **verification**: `bun test tests/docs/drift.test.ts tests/commands/generate.test.ts && bun run typecheck`

### P5-03 — Migrate AI review gate, quality setup, and LSP diagnostic helper

- **files**:
  - Modify: `src/quality/gates/ai-review.ts`
  - Modify: `src/quality/ai-setup.ts`
  - Modify: `src/lsp/bridge.ts`
  - Modify: `src/config/schema.ts`
  - Create: `tests/quality/gates/ai-review.test.ts`
  - Create: `tests/quality/ai-setup.test.ts`
  - Modify: `tests/lsp/bridge.test.ts`
- **criteria**:
  - these flows generate prompt-visible schemas from canonical contracts
  - invalid outputs retry through the shared foundation
  - explicit blocked errors replace silent parse failure and raw-JSON assumptions
- **complexity**: medium
- **depends on**: P1-01
- **verification**: `bun test tests/quality/gates/ai-review.test.ts tests/quality/ai-setup.test.ts tests/lsp/bridge.test.ts && bun run typecheck`

**Phase 5 exit gate**: commit plans validate full staged-file coverage; doc-drift no longer fabricates findings heuristically; AI review gate, quality setup, and LSP helper consume validated contracts and retry or block deterministically.

---

## Phase 6 — Discovery and retrieval layer

Depends on: P0 (so ranking changes can be proved behaviorally). Safest after P3–P5 because discovery will be wired into the workflows they touch.

### P6-01 — Deterministic discovery core

- **files**:
  - Create: `src/discovery/index.ts`
  - Create: `src/discovery/rank.ts`
  - Create: `src/discovery/sources.ts`
  - Create: `tests/discovery/rank.test.ts`
  - Modify: `src/types.ts`
- **criteria**:
  - module ranks likely-relevant files and symbols from deterministic local sources: workspace metadata, changed files, tracked files, and path-to-target mappings
  - outputs include a short rationale for why each candidate was surfaced
  - ranking is deterministic and fixture-testable
  - no hosted service is required
- **complexity**: large
- **depends on**: P0-01
- **verification**: `bun test tests/discovery/rank.test.ts && bun run typecheck`

### P6-02 — LSP-assisted ranking with graceful fallback

- **files**:
  - Modify: `src/discovery/rank.ts`
  - Create: `src/discovery/lsp.ts`
  - Modify: `src/lsp/bridge.ts`
  - Create: `tests/discovery/lsp.test.ts`
- **criteria**:
  - LSP-assisted ranking uses symbols, references, and definitions when LSP is available
  - fallback is clean and tested when LSP is unavailable
  - rationale still explains which source contributed the rank
- **complexity**: medium
- **depends on**: P6-01
- **verification**: `bun test tests/discovery/ && bun run typecheck`

### P6-03 — Integrate discovery into `/supi:review` and quality gates

- **files**:
  - Modify: `src/commands/ai-review.ts`
  - Modify: `src/quality/runner.ts`
  - Modify: `tests/commands/ai-review.test.ts`
  - Modify: `tests/quality/runner.test.ts`
- **criteria**:
  - review target selection and quality-gate scope consume ranked candidates from P6-01/02
  - behavior stays stable when discovery is disabled or inconclusive
  - workflows surface the rationale, not opaque guesses
- **complexity**: medium
- **depends on**: P6-01, P6-02
- **verification**: `bun test tests/commands/ai-review.test.ts tests/quality/runner.test.ts`

### P6-04 — Integrate discovery into `/supi:plan`, `/supi:qa`, `/supi:fix-pr`

- **files**:
  - Modify: `src/commands/plan.ts`
  - Modify: `src/commands/qa.ts`
  - Modify: `src/commands/fix-pr.ts`
  - Modify: `tests/commands/plan.test.ts`
  - Modify: `tests/commands/qa.test.ts`
  - Modify: `tests/commands/fix-pr.test.ts`
- **criteria**:
  - each command consumes ranked candidates where relevant
  - fallback behavior is deterministic when discovery is disabled
  - no workflow begins from broad wandering when a clear candidate is available
- **complexity**: medium
- **depends on**: P6-01
- **verification**: `bun test tests/commands/plan.test.ts tests/commands/qa.test.ts tests/commands/fix-pr.test.ts`

**Phase 6 exit gate**: fixture workspaces rank expected files and symbols first; workflows surface rationale rather than opaque guesses; discovery orchestrates native tools rather than competing with them.

---

## Phase 7 — Workflow rollouts

### P7A — QA and fix-pr rollout

Depends on: P4 (for guardrails) and P6 (for discovery).

#### P7-01 — Typed fix-pr review-comment assessment artifact

- **files**:
  - Create: `src/fix-pr/contracts.ts`
  - Create: `src/fix-pr/assessment.ts`
  - Modify: `src/commands/fix-pr.ts`
  - Modify: `src/fix-pr/prompt-builder.ts`
  - Modify: `src/storage/fix-pr-sessions.ts`
  - Create: `tests/fix-pr/assessment.test.ts`
  - Modify: `tests/commands/fix-pr.test.ts`
- **criteria**:
  - fix-pr produces a validated artifact per comment with verdict, rationale, affected files, ripple effects, and verification plan
  - grouping derives from the artifact, not from free-form prose
  - persisted session state includes the structured assessment
- **complexity**: large
- **depends on**: P1-01
- **verification**: `bun test tests/fix-pr/assessment.test.ts tests/commands/fix-pr.test.ts && bun run typecheck`

#### P7-02 — fix-pr completion blocker for unresolved selected-target comments

- **files**:
  - Modify: `src/commands/fix-pr.ts`
  - Modify: `tests/commands/fix-pr.test.ts`
- **criteria**:
  - fix-pr cannot mark work complete while clustered comments for the selected target remain unresolved
  - blocker message lists the remaining unresolved comments
- **complexity**: small
- **depends on**: P4-05, P7-01
- **verification**: `bun test tests/commands/fix-pr.test.ts`

#### P7-03 — fix-pr discovery integration

- **files**:
  - Modify: `src/commands/fix-pr.ts`
  - Modify: `src/fix-pr/fetch-comments.ts`
  - Modify: `tests/commands/fix-pr.test.ts`
- **criteria**:
  - fix-pr uses discovery to narrow relevant files around each comment target
  - rationale is visible in the session artifact
- **complexity**: small
- **depends on**: P6-04, P7-01
- **verification**: `bun test tests/commands/fix-pr.test.ts tests/fix-pr/fetch-comments.test.ts`

#### P7-04 — QA completion blocker and truthful setup/session reporting

- **files**:
  - Modify: `src/commands/qa.ts`
  - Modify: `tests/commands/qa.test.ts`
- **criteria**:
  - QA blocks when required setup/session artifacts are missing
  - QA never claims readiness without a verified artifact
- **complexity**: small
- **depends on**: P4-04
- **verification**: `bun test tests/commands/qa.test.ts`

#### P7-05 — QA discovery integration for route/test focus

- **files**:
  - Modify: `src/commands/qa.ts`
  - Modify: `src/qa/discover-routes.ts`
  - Modify: `tests/commands/qa.test.ts`
  - Modify: `tests/qa/discover-routes.test.ts`
- **criteria**:
  - QA uses discovery to focus route/test selection
  - fallback when discovery is unavailable is deterministic and preserves current behavior
- **complexity**: small
- **depends on**: P6-04, P7-04
- **verification**: `bun test tests/commands/qa.test.ts tests/qa/discover-routes.test.ts`

#### P7-06 — QA + fix-pr behavior evals

- **files**:
  - Create: `tests/evals/qa-refuses-premature-complete.test.ts`
  - Create: `tests/evals/qa-creates-session-and-prompt-context.test.ts`
  - Create: `tests/evals/fix-pr-selects-target-and-persists-session.test.ts`
  - Create: `tests/evals/fix-pr-blocks-complete-with-unresolved-selected-comments.test.ts`
- **criteria**:
  - each eval fails on the named regression class and passes on the current hardened workflow
  - evals exercise persisted session artifacts, not only in-memory state
- **complexity**: medium
- **depends on**: P0-01, P7-02, P7-04
- **verification**: `bun run test:evals --filter qa && bun run test:evals --filter fix-pr`

### P7B — Release phase gating

Depends on: P1 (structured-output foundation), P4-01 (invariant layer), P5-02 (typed doc-drift findings, since doc-fix subflow reuses them).

#### P7-07 — Typed release-note polish and doc-fix AI contracts

- **files**:
  - Create: `src/release/contracts.ts`
  - Modify: `src/commands/release.ts`
  - Modify: `src/docs/drift.ts`
  - Create: `tests/release/contracts.test.ts`
  - Modify: `tests/commands/release.test.ts`
- **criteria**:
  - release-note polish returns a validated artifact rather than arbitrary text
  - doc-fix subflow returns validated edit instructions or an explicit blocked state
  - release stops truthfully when contract validation fails
- **complexity**: medium
- **depends on**: P1-01, P5-02
- **verification**: `bun test tests/release/contracts.test.ts tests/commands/release.test.ts && bun run typecheck`

#### P7-08 — Explicit phase order and blocked reporting in `/supi:release`

- **files**:
  - Modify: `src/commands/release.ts`
  - Modify: `src/types.ts`
  - Modify: `tests/commands/release.test.ts`
- **criteria**:
  - release command exposes explicit phases in code, not only in prompt prose
  - blocked states fire when any upstream artifact is invalid
  - edit/publish steps never run without a validated phase result
  - no silent degradation into ambiguous output handling remains
- **complexity**: medium
- **depends on**: P7-07, P4-01
- **verification**: `bun test tests/commands/release.test.ts`

**Phase 7 exit gate**: QA, fix-pr, and release all expose explicit phases in code; none can report completion honestly without validated upstream artifacts; the old prose-first path is removed rather than kept alive beside the new path.

---

## Phase 8 — Observability, failure mining, and local reliability scorecards

### P8A — Local reliability metrics and scorecards

Depends on: workflows from P1, P3, P5, P7 so the metrics describe the intended steady state rather than a transition.

#### P8-01 — Reliability event contracts and storage

- **files**:
  - Modify: `src/types.ts`
  - Create: `src/storage/reliability-metrics.ts`
  - Create: `tests/storage/reliability-metrics.test.ts`
- **criteria**:
  - canonical record for attempts, retries, blocked outcomes, fallback usage, and command completion
  - records are written, loaded, and aggregated deterministically from local storage
  - no telemetry is sent outside the project
- **complexity**: medium
- **depends on**: P1-01
- **verification**: `bun test tests/storage/reliability-metrics.test.ts && bun run typecheck`

#### P8-02 — Instrument shared helpers and AI-heavy commands

- **files**:
  - Modify: `src/ai/structured-output.ts`
  - Modify: `src/review/output.ts`
  - Modify: `src/commands/plan.ts`
  - Modify: `src/git/commit.ts`
  - Modify: `src/docs/drift.ts`
  - Modify: `src/commands/fix-pr.ts`
  - Modify: `src/commands/release.ts`
  - Modify: `src/quality/ai-setup.ts`
  - Modify: `src/quality/gates/ai-review.ts`
  - Modify: `tests/commands/plan.test.ts`
  - Modify: `tests/git/commit.test.ts`
  - Modify: `tests/docs/drift.test.ts`
  - Modify: `tests/commands/fix-pr.test.ts`
  - Modify: `tests/commands/release.test.ts`
- **criteria**:
  - each command records structured reliability outcomes without changing user-visible semantics
  - metrics distinguish success, blocked, retry exhaustion, and manual fallback outcomes
  - no workflow loses functional test coverage while gaining instrumentation
- **complexity**: large
- **depends on**: P8-01, P1-01
- **verification**: `bun test tests/commands/plan.test.ts tests/git/commit.test.ts tests/docs/drift.test.ts tests/commands/fix-pr.test.ts tests/commands/release.test.ts && bun run typecheck`

#### P8-03 — Surface scorecards in `/supi:status` and `/supi:doctor`

- **files**:
  - Modify: `src/commands/status.ts`
  - Modify: `src/commands/doctor.ts`
  - Modify: `src/storage/reports.ts`
  - Modify: `tests/commands/status.test.ts`
  - Modify: `tests/commands/doctor.test.ts`
- **criteria**:
  - status and doctor summarize recent reliability of AI-heavy commands using concrete numbers: parse success rate, blocked rate, retries per run, manual fallback count
  - summaries are grounded in stored metrics, not inferred from logs
- **complexity**: medium
- **depends on**: P8-01, P8-02
- **verification**: `bun test tests/commands/status.test.ts tests/commands/doctor.test.ts`

### P8B — Failure mining from stored artifacts

Depends on: P8-01, and populated session stores from P7.

#### P8-04 — Failure taxonomy module

- **files**:
  - Create: `src/discipline/failure-taxonomy.ts`
  - Create: `tests/discipline/failure-taxonomy.test.ts`
- **criteria**:
  - taxonomy classes cover premature completion, wrong tool path, missing artifact, skipped verification, discovery miss, and unproductive retry loop
  - fixture sessions are classified deterministically
  - the taxonomy is small enough to drive action and big enough to cover observed failures
- **complexity**: medium
- **depends on**: P8-01
- **verification**: `bun test tests/discipline/failure-taxonomy.test.ts && bun run typecheck`

#### P8-05 — Offline summarizer over stored sessions and debug traces

- **files**:
  - Create: `src/discipline/failure-summarizer.ts`
  - Create: `tests/discipline/failure-summarizer.test.ts`
  - Modify: `src/context-mode/hooks.ts`
  - Modify: `src/debug/logger.ts`
  - Modify: `src/storage/review-sessions.ts`
  - Modify: `src/storage/qa-sessions.ts`
  - Modify: `src/storage/fix-pr-sessions.ts`
- **criteria**:
  - summarizer produces a compact, repo-local report from stored sessions and debug traces
  - empty or partially missing session data never crashes the summarizer
  - repeated failure categories aggregate deterministically
  - the report format is stable enough to review in code review
- **complexity**: large
- **depends on**: P8-04
- **verification**: `bun test tests/discipline/failure-summarizer.test.ts && bun run typecheck`

#### P8-06 — Failure-to-fix mapping discipline

- **files**:
  - Create: `docs/supipowers/failure-mining.md`
  - Create: `tests/evals/<mined-failure>.test.ts` (one new eval promoted from a mined class, concrete filename chosen when the first class is mined)
- **criteria**:
  - documented rule: every recurring failure class maps to a new behavior eval, new runtime guardrail, tool contract fix, or prompt simplification
  - at least one mined class is promoted into a Phase 0-style eval as a proving case
- **complexity**: small
- **depends on**: P8-05
- **verification**: `bun run test:evals --filter <name-of-promoted-eval>`

**Phase 8 exit gate**: reliability is measurable locally without a hosted telemetry service; mined failures produce concrete new hardening work instead of staying anecdotal; status/doctor summaries are grounded in stored metrics.

---

## Post-phase verification suite

Run before declaring the roadmap complete:

- `bun test`
- `bun run test:evals`
- `bun run typecheck`
- `bun run build`

## Cross-cutting risks

These are mirrored from the `Risks to watch` sections of the source plans and apply across multiple phases. They are not scheduled tasks; they are things a reviewer must check during each phase.

- abstracting too much too early and creating shared code only one consumer understands
- keeping a review-local path alive alongside the shared foundation after P1
- letting the renderer drift from the parser after P3-02
- making typed assessments in P7-01 exist only as logging while execution still reads prose
- preserving fallback paths that bypass the new phase gates in P7
- collecting metrics in P8 that are too vague to drive decisions
- instrumenting before command shapes stabilize, causing rework

## Definition of done for the whole backlog

The consolidation and rollout are complete only when every statement below is true:

- workflow regressions are caught by behavior evals, not only by unit tests
- AI-heavy workflows consume validated artifacts or block truthfully
- `/supi:plan` uses a canonical validated plan artifact and deterministic markdown rendering
- commit, docs, AI gates, QA, fix-pr, and release no longer depend on heuristic parsing for critical decisions
- completion cannot be reported while required artifacts, verification, or unresolved work are still missing
- discovery ranks the right files and symbols early enough to improve large-repo performance materially
- tool misuse decreases because the preferred path is simple and explicit
- stored sessions and local metrics routinely produce new hardening work
- status/doctor can describe reliability with concrete numbers grounded in local storage
