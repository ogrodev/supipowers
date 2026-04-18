---
name: autobe-chunk-4-fix-pr-release-phase-gating
created: 2026-04-17
tags: [autobe, improvement-plan, fix-pr, release, orchestration]
---

# Chunk 4: Phase-gate fix-pr and release

## Goal

Add explicit, validated pre-execution phases to the heaviest orchestration commands so they stop moving directly from prompt prose to code or publishing actions.

## Why this chunk exists

`/supi:fix-pr` and `/supi:release` are the two flows where a “smart prompt” failure is most expensive:

- `src/commands/fix-pr.ts` and `src/fix-pr/prompt-builder.ts` describe assessment/grouping discipline in prose, but the assessment itself is not captured as a validated intermediate artifact.
- `src/commands/release.ts` executes deterministic git/publish steps well, but its AI-assisted subflows such as changelog polish and doc fixing still accept raw text with weak contracts.

This chunk applies the AutoBE lesson directly: phase boundaries should be represented in code, not only in instructions.

## Non-goals

- Do not redesign the release executor’s deterministic git/publish logic.
- Do not change the selected-target semantics of `/supi:fix-pr`.
- Do not add compatibility shims that keep both prose-first and contract-first paths alive.

## Chunk acceptance

This chunk is complete when:

- fix-pr creates a validated per-comment assessment artifact before edits start
- release AI subflows return validated artifacts or explicit blocked status
- both commands enforce phase order in code instead of depending on prompt discipline alone
- targeted tests cover invalid artifacts, blocked states, and successful end-to-end handoff between phases

## Tasks

### 1. Add typed review-comment assessment and grouping to `/supi:fix-pr`

- **files**:
  - Create: `src/fix-pr/contracts.ts`
  - Create: `src/fix-pr/assessment.ts`
  - Modify: `src/commands/fix-pr.ts`
  - Modify: `src/fix-pr/prompt-builder.ts`
  - Modify: `src/storage/fix-pr-sessions.ts`
  - Create: `tests/fix-pr/assessment.test.ts`
  - Modify: `tests/commands/fix-pr.test.ts`
- **criteria**: fix-pr produces a validated artifact per comment containing verdict, rationale, affected files, ripple effects, and verification plan; grouping into work batches is derived from that artifact instead of free-form orchestrator prose.
- **complexity**: large

Suggested verification:
- `bun test tests/fix-pr/assessment.test.ts tests/commands/fix-pr.test.ts`
- `bun run typecheck`

### 2. Add typed AI contracts for release-note polish and doc-fix subflows

- **files**:
  - Create: `src/release/contracts.ts`
  - Modify: `src/commands/release.ts`
  - Modify: `src/docs/drift.ts`
  - Create: `tests/release/contracts.test.ts`
  - Modify: `tests/commands/release.test.ts`
- **criteria**: release-note polish returns a validated artifact rather than arbitrary text, doc-fix subflows return validated edit instructions or a blocked state, and release stops truthfully when contract validation fails instead of silently degrading into ambiguous output handling.
- **complexity**: medium

Suggested verification:
- `bun test tests/release/contracts.test.ts tests/commands/release.test.ts`
- `bun run typecheck`

### 3. Encode phase order and blocked reporting into command orchestration

- **files**:
  - Modify: `src/commands/fix-pr.ts`
  - Modify: `src/commands/release.ts`
  - Modify: `src/types.ts`
  - Modify: `tests/commands/fix-pr.test.ts`
  - Modify: `tests/commands/release.test.ts`
- **criteria**: both commands expose explicit phases in code, surface blocked states when an upstream artifact is invalid, and never proceed to edit/publish steps without a validated phase result.
- **complexity**: medium

Suggested verification:
- `bun test tests/commands/fix-pr.test.ts tests/commands/release.test.ts`
- `bun run typecheck`

## Risks to watch

- letting the typed assessment exist only as logging while execution still reads prose
- making release-note polish look structured but not actually constrain downstream behavior
- preserving fallback paths that bypass the new phase gate entirely

## Exit criteria

After this chunk:

- `/supi:fix-pr` should feel like a validated assessment pipeline followed by deterministic execution
- `/supi:release` should keep its strong deterministic executor while treating AI-generated inputs as contracts, not suggestions

This is the closest supipowers gets to AutoBE’s phase-gated orchestration pattern.
