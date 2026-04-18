# Chunk 06 — QA and fix-pr rollout

## Objective

Apply the proven reliability patterns from earlier chunks to the next two high-leverage workflows: `/supi:qa` and `/supi:fix-pr`.

## Why this chunk exists

Supipowers already has strong review and planning machinery. The next question is whether the same lessons are reused consistently in adjacent workflows.

The repo already shows both workflows have meaningful orchestration logic:
- `/supi:qa` resolves workspace targets, detects app type, discovers routes, builds an orchestrator prompt, and persists sessions (`src/commands/qa.ts` plus `src/qa/*`)
- `/supi:fix-pr` discovers workspace targets, fetches and clusters review comments, selects one target, builds an orchestrator prompt, and persists sessions (`src/commands/fix-pr.ts` plus `src/fix-pr/*`)

That makes them strong candidates for the shared improvements from chunks 01 through 05.

## Why this chunk comes last

QA and fix-pr should not each invent their own versions of:
- behavior evals
- completion guardrails
- discovery heuristics
- tool/prompt hardening
- telemetry reporting

Those shared pieces should stabilize first. Then rollout becomes an integration exercise instead of another design exercise.

## Proposed work

1. Add chunk-01 style behavior evals for both commands.
2. Apply chunk-02 guardrails where they fit naturally:
   - QA should not claim readiness if setup/session artifacts are missing
   - fix-pr should not claim work is complete if clustered comments remain unresolved for the selected target
3. Route both workflows through the chunk-03 discovery layer where relevant:
   - QA can use better entry-point selection for route/test focus
   - fix-pr can use discovery to narrow relevant files around the comment target
4. Audit both workflows’ prompt builders and tool contracts using chunk 04 rules.
5. Feed their persisted sessions into the chunk-05 failure-mining loop.

## Likely files and modules

- `src/commands/qa.ts`
- `src/qa/config.ts`
- `src/qa/detect-app-type.ts`
- `src/qa/discover-routes.ts`
- `src/qa/prompt-builder.ts`
- `src/commands/fix-pr.ts`
- `src/fix-pr/fetch-comments.ts`
- `src/fix-pr/prompt-builder.ts`
- `src/storage/qa-sessions.ts`
- `src/storage/fix-pr-sessions.ts`
- tests under `tests/qa/` and `tests/fix-pr/`

## Test plan

Automated checks for this chunk should cover:
- QA target selection and session setup still work after the new guardrails
- fix-pr target selection and comment clustering still work after the new discovery/guardrail changes
- both commands produce the expected persisted session artifacts
- new behavior evals catch the most important failure cases for each command
- previously passing unit tests in `tests/qa/` and `tests/fix-pr/` still pass

Suggested first evals:
- `qa-refuses-premature-complete`
- `qa-creates-session-and-prompt-context`
- `fix-pr-selects-target-and-persists-session`
- `fix-pr-blocks-complete-with-unresolved-selected-comments`

## Exit criteria

This chunk is done when:
- QA and fix-pr both reuse the shared reliability pieces instead of bespoke copies
- both workflows have behavior eval coverage
- both workflows expose truthful blocking states and completion signals
- both workflows produce better task focus through the discovery layer

## Non-goals

- redesigning QA or fix-pr from scratch
- expanding to every command immediately after these two
- adding broad sub-agent parallelism unless the workflow genuinely benefits

## Dependencies

This chunk should land after the shared foundations from chunks 01 through 05 are available.
