# Chunk 05 — telemetry and failure-mining loop

## Objective

Turn supipowers’ stored workflow artifacts into an explicit improvement loop that discovers recurring failure modes and feeds them back into tests and runtime hardening.

## Why this chunk exists

The ForgeCode lesson is not only “have evals.” It is “mine failures, classify them, and freeze the fix into a regression check.”

Supipowers already stores useful evidence:
- planning debug logs are created from `src/commands/plan.ts`
- context-mode tracks events and knowledge in `src/context-mode/hooks.ts`
- review sessions are persisted under `src/storage/review-sessions.ts`
- QA and fix-pr each persist session state under `src/storage/qa-sessions.ts` and `src/storage/fix-pr-sessions.ts`
- debug logging support exists in `src/debug/logger.ts`

That is enough to build a local, evidence-driven improvement loop without external analytics infrastructure.

## Current gap

The repo stores rich operational data, but there is not yet a clear workflow for answering:
- what are the top repeated failure modes?
- which workflow regressed most often this week?
- which failure classes deserve a new eval or a new runtime guardrail?

Without that loop, stored artifacts help debugging individual sessions but do not systematically improve the product.

## Proposed work

1. Define a small failure taxonomy for supipowers workflows, for example:
   - premature completion
   - wrong tool path
   - missing artifact
   - verification skipped
   - retrieval/discovery miss
   - repeated loop / unproductive retries
2. Build an offline summarizer that can scan stored sessions and traces and emit a compact report.
3. Add a repeatable rule: every recurring failure category must map to one of these follow-ups:
   - new behavior eval
   - new runtime guardrail
   - tool contract fix
   - prompt simplification
4. Store the mined findings in a repo-local format that is easy to review and turn into work items.
5. Keep the whole loop local-first and deterministic.

## Likely files and modules

- `src/context-mode/hooks.ts`
- `src/debug/logger.ts`
- `src/storage/review-sessions.ts`
- `src/storage/qa-sessions.ts`
- `src/storage/fix-pr-sessions.ts`
- likely a new analysis module under `src/debug/`, `src/research/`, or `src/discipline/`
- tests around fixture session data under a new `tests/` subtree

## Test plan

Automated checks should prove:
- fixture sessions are classified into the right failure categories
- empty or partially missing session data does not crash the summarizer
- repeated failure categories are aggregated deterministically
- the generated report format is stable enough to review in code review
- at least one mined category is converted into a chunk-01 eval as a proving case

## Exit criteria

This chunk is done when:
- supipowers can produce a local summary of recurring workflow failures
- the failure taxonomy is explicit and covered by tests
- there is a documented path from observed failure to regression test / guardrail
- the output is actionable enough that future hardening work can start from evidence instead of anecdotes

## Non-goals

- shipping a telemetry backend
- collecting user data outside the local project state
- replacing direct debugging for one-off incidents

## Dependencies

Most valuable after chunks 01 through 04 start landing, because that is when mined failures can turn directly into new evals and targeted fixes.
