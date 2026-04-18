---
name: autobe-chunk-3-command-hardening
created: 2026-04-17
tags: [autobe, improvement-plan, commit, docs, quality]
---

# Chunk 3: Harden commit, docs, and AI gate flows

## Goal

Move the smaller AI-heavy commands off one-shot parsing, regex scraping, and heuristic fallback paths, and onto the shared structured-output foundation.

## Why this chunk exists

These commands already want structured outputs, but they still trust the model too directly:

- `src/git/commit.ts` parses one fenced JSON block and falls back to manual entry
- `src/docs/drift.ts` extracts JSON with regex and falls back to heuristics
- `src/quality/gates/ai-review.ts` and `src/quality/ai-setup.ts` parse once and stop on invalid output
- `src/lsp/bridge.ts` also depends on AI-produced JSON for diagnostics collection

These are high-value, moderate-risk migrations because they improve correctness without changing the largest orchestration flows yet.

## Non-goals

- Do not redesign commit UX beyond making artifact validation deterministic.
- Do not expand doc-drift scope or rewrite its overall feature set.
- Do not merge these commands into one shared runtime; only unify how they accept AI artifacts.

## Chunk acceptance

This chunk is complete when:

- commit planning uses shared schema-backed retries and invariant checks
- doc drift stops using regex JSON scraping and heuristic drift inference
- AI review/setup/LSP helpers consume validated artifacts through the shared foundation
- each migrated command has targeted tests for invalid output, retry, blocked, and success paths

## Tasks

### 1. Migrate commit planning to shared structured-output contracts

- **files**:
  - Modify: `src/git/commit.ts`
  - Create: `src/git/commit-contract.ts`
  - Modify: `tests/git/commit.test.ts`
- **criteria**: commit planning uses the shared structured-output helper, validates that every staged file is covered exactly once, retries invalid plans automatically, and only falls back to manual commit entry after the structured path is exhausted.
- **complexity**: medium

Suggested verification:
- `bun test tests/git/commit.test.ts`
- `bun run typecheck`

### 2. Replace doc-drift regex and heuristic parsing with typed findings

- **files**:
  - Modify: `src/docs/drift.ts`
  - Modify: `src/commands/generate.ts`
  - Create: `src/docs/contracts.ts`
  - Modify: `tests/docs/drift.test.ts`
  - Modify: `tests/commands/generate.test.ts`
- **criteria**: doc-drift findings are parsed and validated against a canonical schema; invalid outputs retry with feedback; unparseable prose no longer turns into synthetic drift findings by heuristic guesswork.
- **complexity**: large

Suggested verification:
- `bun test tests/docs/drift.test.ts tests/commands/generate.test.ts`
- `bun run typecheck`

### 3. Migrate AI review gate, quality setup, and LSP diagnostic helper to canonical contracts

- **files**:
  - Modify: `src/quality/gates/ai-review.ts`
  - Modify: `src/quality/ai-setup.ts`
  - Modify: `src/lsp/bridge.ts`
  - Modify: `src/config/schema.ts`
  - Modify: `tests/quality/gates/ai-review.test.ts`
  - Modify: `tests/quality/ai-setup.test.ts`
  - Modify: `tests/lsp/bridge.test.ts`
- **criteria**: these flows generate prompt-visible schemas from canonical contracts, retry invalid outputs through the shared foundation, and return explicit blocked errors instead of silent parse failure or raw JSON assumptions.
- **complexity**: medium

Suggested verification:
- `bun test tests/quality/gates/ai-review.test.ts tests/quality/ai-setup.test.ts tests/lsp/bridge.test.ts`
- `bun run typecheck`

## Risks to watch

- keeping command-local parsing helpers after migration
- reintroducing schema duplication inside prompt strings
- overfitting the shared foundation to one command’s edge cases

## Exit criteria

After this chunk:

- commit plans are validated artifacts, not just JSON-looking text
- doc drift either returns validated findings or blocks truthfully
- AI quality helpers share the same artifact contract behavior as review

This gives supipowers a broad middle layer of reliable AI consumers before tackling the most orchestration-heavy commands.
