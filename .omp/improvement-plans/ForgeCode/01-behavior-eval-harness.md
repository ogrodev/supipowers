# Chunk 01 — behavior eval harness

## Objective

Add a dedicated behavior-level evaluation layer for supipowers workflows so regressions are caught as workflow failures, not only as unit-test failures.

## Why this chunk exists

ForgeCode’s biggest durable lesson is not a specific prompt. It is the discipline of converting repeated agent failures into tiny repeatable evals.

Supipowers already has solid unit coverage in areas like:
- `tests/planning/`
- `tests/context-mode/`
- `tests/review/`
- `tests/integration/extension.test.ts`

But those tests do not yet form a first-class workflow-eval harness. Today the repo can prove individual helpers work, yet still miss trajectory regressions such as:
- a plan flow that asks the wrong question type
- a review flow that reports findings before validation
- a context-mode route that silently stops enforcing `ctx_*` tools
- a workflow that finishes without creating the expected artifact

## Current footing to build on

- command registration and hook wiring already have integration coverage in `tests/integration/extension.test.ts`
- planning already has focused tests under `tests/planning/`
- context-mode already has dedicated test coverage under `tests/context-mode/`
- review agent orchestration already has tests under `tests/review/`

That means the missing piece is not “testing from scratch.” It is a new test layer that exercises end-to-end workflow behavior with tighter pass/fail contracts.

## Proposed work

1. Introduce a dedicated eval directory, likely `tests/evals/`, with a lightweight runner built on Bun.
2. Create reusable fixtures that describe:
   - starting command / input
   - available platform capabilities
   - expected tool/hook usage
   - expected files or persisted artifacts
   - expected completion or blocking conditions
3. Add the first seed evals for the highest-leverage invariants:
   - `/supi:plan` saves a plan to `.omp/supipowers/plans/...` and stops
   - planning mode uses `planning_ask` instead of `ask`
   - context-mode routes high-output work through `ctx_*` tools
   - `/supi:review` validates findings before presenting final findings output
   - review loop reruns after fixes when requested
4. Add a dedicated package script, for example `test:evals`, so the eval layer is easy to run separately from fast unit tests.
5. Make later chunks add or update evals as part of their acceptance criteria.

## Likely files and modules

- `package.json`
- `tests/evals/` (new)
- `tests/integration/` or `tests/helpers/` for shared harness utilities
- possibly a small shared helper under `src/` only if the test harness cannot stay test-local

## Test plan

Minimum automated checks for this chunk:
- `bun test tests/evals/` passes
- each seed eval fails on the intended regression class
- failure messages are diagnostic enough to show which invariant broke
- existing planning/review/context-mode tests still pass

Recommended seed eval set:
1. `plan-saves-and-stops`
2. `plan-uses-planning-ask`
3. `context-mode-routes-large-output`
4. `review-validates-before-report`
5. `review-rerun-loop`

## Exit criteria

This chunk is done when:
- a dedicated eval harness exists in the repo
- at least five workflow evals are running deterministically
- later work can add evals without inventing a new harness pattern
- the new harness is documented well enough that future regressions get encoded as evals by default

## Non-goals

- cloning Terminal Bench
- adding a hosted benchmark service
- replacing existing unit tests
- requiring real remote LLM calls in CI

## Dependencies

None. This chunk should land first.
