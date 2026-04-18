---
name: autobe-chunk-5-reliability-evaluation
created: 2026-04-17
tags: [autobe, improvement-plan, metrics, evaluation, reliability]
---

# Chunk 5: Reliability evaluation and scorecards

## Goal

Measure whether the earlier chunks actually improve supipowers by persisting command-level reliability data and surfacing scorecards in status/doctor flows.

## Why this chunk exists

AutoBE does not stop at generation; it also evaluates outcomes. supipowers needs the same discipline.

Without measurement, changes such as “retry more” or “use typed contracts” remain beliefs. The repo already persists useful artifacts for review, fix-pr, QA, and reports; this chunk extends that idea to reliability evidence:

- parse success rate
- retry count
- blocked/error rate
- fallback/manual-intervention rate
- command-specific invariant failures

## Non-goals

- Do not build a generic analytics platform.
- Do not send telemetry outside the local repo.
- Do not add noisy user-facing dashboards before the stored metrics are trustworthy.

## Chunk acceptance

This chunk is complete when:

- AI-heavy commands emit a shared reliability event/result shape
- metrics are persisted locally with tests
- status and doctor surfaces can show command-level reliability summaries
- at least planning, review, commit, docs, fix-pr, release, and AI setup flows are instrumented

## Tasks

### 1. Define reliability event contracts and storage

- **files**:
  - Modify: `src/types.ts`
  - Create: `src/storage/reliability-metrics.ts`
  - Create: `tests/storage/reliability-metrics.test.ts`
- **criteria**: code defines a canonical record for attempts, retries, blocked status, fallback usage, and command outcome; records can be written, loaded, and aggregated deterministically from local storage.
- **complexity**: medium

Suggested verification:
- `bun test tests/storage/reliability-metrics.test.ts`
- `bun run typecheck`

### 2. Instrument AI-heavy commands and shared helpers

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
- **criteria**: each targeted command records structured reliability outcomes without changing its user-visible semantics; metrics distinguish success, blocked, retry exhaustion, and manual fallback paths.
- **complexity**: large

Suggested verification:
- `bun test tests/commands/plan.test.ts tests/git/commit.test.ts tests/docs/drift.test.ts tests/commands/fix-pr.test.ts tests/commands/release.test.ts`
- `bun run typecheck`

### 3. Surface scorecards in status and doctor flows

- **files**:
  - Modify: `src/commands/status.ts`
  - Modify: `src/commands/doctor.ts`
  - Modify: `src/storage/reports.ts`
  - Modify: `tests/commands/status.test.ts`
  - Modify: `tests/commands/doctor.test.ts`
- **criteria**: status and doctor can summarize the recent reliability of AI-heavy commands with concrete numbers such as parse success, blocked rate, retries per run, and manual fallback count; summaries are grounded in stored metrics, not inferred from logs.
- **complexity**: medium

Suggested verification:
- `bun test tests/commands/status.test.ts tests/commands/doctor.test.ts`
- `bun run typecheck`

## Risks to watch

- collecting metrics that are too vague to drive decisions
- instrumenting before the command shapes stabilize, causing churn
- confusing debug traces with stable reliability records

## Exit criteria

After this chunk, supipowers should be able to answer questions like:

- Did schema-first planning reduce invalid-output retries?
- Did commit planning’s manual fallback rate drop after contract migration?
- Which command still blocks most often on invalid AI artifacts?
- Did phase-gating reduce fix-pr or release failure modes?

That turns the AutoBE lesson into an engineering feedback loop rather than a one-time refactor.
