---
name: autobe-chunk-1-structured-output-foundation
created: 2026-04-17
tags: [autobe, improvement-plan, ai, reliability, foundation]
---

# Chunk 1: Shared structured-output foundation

## Goal

Create one shared, schema-backed path for AI outputs so commands stop re-implementing parsing, retry, validation, and normalization independently.

## Why this chunk exists

supipowers already has the right reliability pattern inside review, but it is trapped inside review-specific modules.

Current evidence:
- `src/review/output.ts` already retries invalid outputs and validates them against TypeBox schemas.
- `src/quality/ai-session.ts` already knows how to create a headless agent session and extract the final assistant text.
- other commands still parse raw text on their own or accept one-shot responses.

This chunk extracts the proven pieces into shared infrastructure without changing the user-visible workflow yet.

## Non-goals

- Do not change `/supi:plan`, `/supi:commit`, `/supi:fix-pr`, or `/supi:release` behavior yet.
- Do not redesign prompt content beyond what is needed to consume canonical schema text.
- Do not add a general-purpose “AI framework”; keep the surface narrow and immediately used.

## Chunk acceptance

This chunk is complete when:

- a shared module owns schema-backed retry + normalization helpers
- prompt-visible schema text comes from one canonical code path
- review uses the shared foundation instead of review-local duplication
- targeted tests prove invalid JSON, schema mismatch, retry exhaustion, and success normalization paths

## Tasks

### 1. Extract generic structured-output execution helpers

- **files**:
  - Create: `src/ai/structured-output.ts`
  - Create: `src/ai/final-message.ts`
  - Modify: `src/quality/ai-session.ts`
  - Modify: `src/review/output.ts`
  - Create: `tests/ai/structured-output.test.ts`
  - Modify: `tests/review/output.test.ts`
- **criteria**: a shared module owns final-assistant extraction, schema-backed parsing, retry orchestration, and blocked-result reporting; review-specific code keeps only review-specific schemas and normalization.
- **complexity**: large

Suggested verification:
- `bun test tests/ai/structured-output.test.ts tests/review/output.test.ts`
- `bun run typecheck`

### 2. Add canonical schema-to-prompt rendering

- **files**:
  - Create: `src/ai/schema-text.ts`
  - Modify: `src/review/types.ts`
  - Modify: `src/review/runner.ts`
  - Modify: `src/review/multi-agent-runner.ts`
  - Modify: `src/review/validator.ts`
  - Modify: `src/review/fixer.ts`
  - Modify: `tests/review/runner.test.ts`
  - Create: `tests/ai/schema-text.test.ts`
- **criteria**: review prompt schema text is generated from the canonical contract definitions or a single shared renderer instead of being hand-maintained in multiple places; a contract change updates prompt-visible schema through one code path.
- **complexity**: medium

Suggested verification:
- `bun test tests/ai/schema-text.test.ts tests/review/runner.test.ts`
- `bun run typecheck`

### 3. Cut the review pipeline over to the shared foundation

- **files**:
  - Modify: `src/review/output.ts`
  - Modify: `src/review/runner.ts`
  - Modify: `src/review/multi-agent-runner.ts`
  - Modify: `src/review/validator.ts`
  - Modify: `src/review/fixer.ts`
  - Modify: `tests/review/validator.test.ts`
  - Modify: `tests/review/fixer.test.ts`
  - Modify: `tests/review/multi-agent-runner.test.ts`
- **criteria**: review still validates, retries, normalizes, and persists the same shapes, but now does so through the shared infrastructure that later chunks can reuse without copying review code.
- **complexity**: medium

Suggested verification:
- `bun test tests/review/validator.test.ts tests/review/fixer.test.ts tests/review/multi-agent-runner.test.ts`
- `bun run typecheck`

## Risks to watch

- extracting too much too early and creating an abstraction that only review understands
- keeping both the old review-local path and the new shared path alive at once
- introducing prompt/schema drift during the transition

## Exit criteria

After this chunk, new AI-heavy flows should no longer need to invent their own:
- JSON extraction rules
- retry loops
- blocked-result handling
- prompt-side schema rendering

That shared path becomes the base for the remaining chunks.
