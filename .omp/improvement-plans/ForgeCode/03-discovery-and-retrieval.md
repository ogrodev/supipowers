# Chunk 03 — discovery and retrieval layer

## Objective

Give supipowers a first-class repo entry-point discovery layer so workflows reach the right files, symbols, and workspace targets faster.

## Why this chunk exists

The ForgeCode research suggests a major part of strong benchmark performance comes from finding the right entry point early, not merely from stuffing more context into the model.

Supipowers already has useful building blocks:
- workspace targeting and selection in `src/commands/ai-review.ts`
- deterministic repo file scope discovery in `src/quality/runner.ts`
- context-mode knowledge and search tools in `src/context-mode/hooks.ts` and `src/context-mode/tools.ts`
- strong use of OMP-native semantic tools available at runtime

What is missing is a single deterministic discovery abstraction that multiple workflows can share.

## Current gap

Today, discovery logic is fragmented:
- review has its own target and scope selection flow
- quality gates discover changed/tracked files independently
- context-mode can search indexed data, but that is not the same thing as repo entry-point selection
- planning, QA, and fix-pr do not yet share one ranked discovery path

This raises the cost of future improvements because every workflow has to rediscover where to start.

## Proposed work

1. Introduce a shared discovery module, likely `src/discovery/`, that can rank likely-relevant files and symbols for a task.
2. Build the first version from deterministic sources already available locally:
   - repo root and workspace target metadata
   - changed files / tracked files
   - path-to-target mappings
   - LSP symbols / references / definitions when available
   - optional reuse of context-mode indexed knowledge where appropriate
3. Produce structured outputs that workflows can consume directly, for example:
   - ranked files
   - ranked symbol candidates
   - short rationale for why each candidate was surfaced
4. Integrate the discovery API into the first workflows that will benefit most:
   - `/supi:review`
   - quality gates
   - `/supi:plan`
   - `/supi:qa`
   - `/supi:fix-pr`
5. Keep the ranking logic deterministic and inspectable; avoid a black-box retrieval service.

## Likely files and modules

- new `src/discovery/` module(s)
- `src/commands/ai-review.ts`
- `src/quality/runner.ts`
- `src/commands/plan.ts`
- `src/commands/qa.ts`
- `src/commands/fix-pr.ts`
- tests under `tests/discovery/` plus workflow-specific tests

## Test plan

Minimum automated checks:
- fixture workspaces return expected ranked files for representative scenarios
- changed files outrank unrelated files when they should
- LSP-assisted ranking falls back cleanly when LSP is unavailable
- review and quality scope integrations preserve existing behavior when discovery is disabled or inconclusive
- evals from chunk 01 can assert that workflows now start from better candidates instead of broad wandering

## Exit criteria

This chunk is done when:
- a shared discovery API exists and is used by at least review and one other workflow
- ranking behavior is deterministic and covered by fixture-based tests
- integrations can explain why a file/symbol was selected
- discovery improves workflow inputs without requiring hosted infrastructure

## Non-goals

- building a remote semantic search service
- adding a vector database as a prerequisite
- replacing OMP’s native tools; this layer should orchestrate them, not compete with them

## Dependencies

Best started after chunk 01. It can proceed in parallel with chunk 04 once the eval harness exists.
