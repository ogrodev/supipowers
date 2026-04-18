---
name: autobe-inspired-reliability-roadmap
created: 2026-04-17
tags: [autobe, improvement-plan, reliability, ai]
---

# AutoBE-Inspired Reliability Roadmap for supipowers

## Goal

Turn supipowers from a set of AI-assisted command flows into a validated orchestration system where AI proposes structured artifacts, deterministic code decides whether they are acceptable, and every major workflow reports measurable reliability.

## Core lesson being applied

AutoBE’s strongest idea is not “use a smarter model.” It is:

1. generate constrained intermediate artifacts
2. validate them immediately
3. deterministically render or execute the final output when possible
4. retry against validator feedback instead of accepting one-shot prose
5. measure the real success rate instead of assuming it

For supipowers, that means copying the reliability pattern, not AutoBE’s full backend-compiler architecture.

## Current repo baseline

The best existing example is the review pipeline:

- `src/review/types.ts`
- `src/review/output.ts`
- `src/review/runner.ts`
- `src/review/multi-agent-runner.ts`
- `src/review/validator.ts`
- `src/review/fixer.ts`

Those modules already use typed contracts, validation, retries, and normalization.

The weaker areas are the commands that still rely on free-form prompts, one-shot parsing, regex extraction, or heuristic fallbacks:

- `src/commands/plan.ts`
- `src/storage/plans.ts`
- `src/git/commit.ts`
- `src/docs/drift.ts`
- `src/quality/gates/ai-review.ts`
- `src/quality/ai-setup.ts`
- `src/commands/fix-pr.ts`
- `src/fix-pr/prompt-builder.ts`
- `src/commands/release.ts`

## Chunk ordering

### Chunk 1 — Shared structured-output foundation
Create one reusable path for schema-backed AI artifacts, retries, normalization, and prompt-side schema rendering.

Why first:
- lowest-risk change with the broadest reuse
- builds on patterns already proven in review
- reduces repeated implementation effort in later chunks

Primary dependency for:
- Chunk 2
- Chunk 3
- Chunk 4

### Chunk 2 — Schema-first planning cutover
Replace free-form planning + markdown re-parsing with a validated `PlanSpec` artifact rendered to markdown deterministically.

Why second:
- `/supi:plan` is a flagship workflow
- `src/storage/plans.ts` currently reconstructs structure from markdown regex
- high leverage, but easier once the shared artifact foundation exists

Depends on:
- Chunk 1

### Chunk 3 — Command hardening for commit, docs, and AI gates
Migrate lower-risk AI consumers to the shared structured-output path and remove regex/heuristic parsing.

Why third:
- direct reliability wins across multiple user-facing commands
- still local enough to test thoroughly without changing the biggest orchestration flows

Depends on:
- Chunk 1

### Chunk 4 — Phase-gated fix-pr and release flows
Add validated intermediate assessment phases to the most orchestration-heavy commands.

Why fourth:
- biggest behavioral changes
- easiest to do once contracts, retries, and schema helpers already exist
- lets release and PR-fix flows report blocked truthfully instead of improvising

Depends on:
- Chunk 1
- informed by Chunk 3 patterns

### Chunk 5 — Reliability evaluation harness
Persist success/failure metrics across AI-heavy commands and surface scorecards in status/doctor flows.

Why last:
- should instrument the final architecture, not a half-migrated one
- gives evidence for whether the previous chunks actually improved the system

Depends on:
- Chunks 2–4 for stable event shapes

## Chunk summary

| Chunk | Theme | Main outcome | Testability |
|---|---|---|---|
| 1 | Shared AI artifact foundation | Common schema/retry/normalization utilities | unit tests + review regression tests |
| 2 | Planning cutover | Validated `PlanSpec` rendered to markdown | planning/storage tests |
| 3 | Command hardening | Commit/docs/AI gate flows use validated artifacts | targeted command/unit tests |
| 4 | Phase-gated orchestration | fix-pr and release gain typed pre-execution phases | command/session tests |
| 5 | Evaluation harness | Measured parse/retry/fallback success rates | storage/status/doctor tests |

## Design rules for every chunk

- Prefer full cutover over bridges. When a workflow gets a typed artifact, that artifact becomes canonical.
- Keep markdown and prose as human-facing renderings, not the source of truth.
- Do not add speculative abstractions; each shared helper must be used by multiple commands immediately.
- Preserve the current review pipeline’s strengths; do not regress it while generalizing its patterns.
- Every chunk must end with targeted tests and a clear blocked/error path.
- When public behavior changes, update docs in the same chunk.

## Definition of done per chunk

A chunk is only complete when:

1. the targeted command(s) consume validated structured artifacts
2. invalid AI output triggers deterministic retry or blocked status
3. command-specific invariants are enforced in code, not left to prompt prose
4. targeted tests pass
5. `bun run typecheck` passes for the changed surface

## Document map

- `01-structured-output-foundation.md`
- `02-schema-first-planning.md`
- `03-command-hardening.md`
- `04-fix-pr-and-release-phase-gating.md`
- `05-reliability-evaluation.md`

## Recommended execution order

1. Chunk 1
2. Chunk 2
3. Chunk 3
4. Chunk 4
5. Chunk 5

Chunks 2 and 3 can proceed in parallel once Chunk 1 lands. Chunk 4 should wait until the shared artifact path is stable. Chunk 5 should land after the main migrations so the metrics describe the final system rather than a transition state.
