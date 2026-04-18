# Chunk 02 — runtime guardrails and completion control

## Objective

Move more workflow correctness from prompt wording into explicit runtime enforcement.

## Why this chunk exists

Supipowers already proves this pattern works in a few places:
- planning mode rewrites the system prompt to hard-gate implementation work in `src/planning/system-prompt.ts`
- plan approval and execution handoff are enforced by hook/UI state in `src/planning/approval-flow.ts`
- context-mode can block or reroute tool calls in `src/context-mode/hooks.ts`
- review already has validate/consolidate/fix/rerun control flow in `src/commands/ai-review.ts`

The lesson from ForgeCode is to extend this style: if a behavior matters, enforce it in code instead of hoping the model follows instructions.

## Current gap

Different supipowers workflows still encode important invariants in different ways. Some are runtime-enforced, some are prompt-enforced, and some are only implied by command flow.

That creates room for drift:
- one workflow may allow premature completion while another blocks it
- one workflow may require verification before yielding while another only suggests it
- one workflow may ask the user questions in contexts that should be autonomous

## Proposed work

1. Define a shared workflow-invariant layer for commands that orchestrate agent work.
2. Model the invariants explicitly, for example:
   - required artifact exists before completion
   - required verification step completed before status becomes complete
   - outstanding todos / pending review state block completion
   - user questions allowed vs disallowed for a given mode
3. Reuse that layer in the highest-value workflows first:
   - `/supi:plan`
   - `/supi:review`
   - `/supi:qa`
   - `/supi:fix-pr`
4. Add a shared “completion blocker” mechanism that can inject a continuation reminder or refuse to mark the workflow complete until invariants are satisfied.
5. Standardize user-visible error/status text so blocked workflows explain the missing condition truthfully.

## Likely files and modules

- `src/bootstrap.ts`
- `src/planning/approval-flow.ts`
- `src/planning/system-prompt.ts`
- `src/commands/ai-review.ts`
- `src/commands/qa.ts`
- `src/commands/fix-pr.ts`
- likely a new shared module under `src/discipline/` or `src/workflows/`
- tests under `tests/planning/`, `tests/review/`, `tests/qa/`, and `tests/fix-pr/`

## Test plan

Automated checks for this chunk should prove:
- planning cannot finish successfully without a saved plan artifact
- review with findings cannot skip the validation stage silently
- workflows with pending follow-up state surface the blocker instead of claiming completion
- workflows that are meant to stay autonomous avoid unnecessary user questions
- chunk-01 evals for planning and review still pass and can assert the new guardrails

## Exit criteria

This chunk is done when:
- the main agentic commands share one guardrail model instead of each inventing its own
- premature completion has at least one explicit runtime blocker per workflow
- verification requirements are encoded in code, not only in prompts
- the new invariants are covered by both unit/integration tests and behavior evals

## Non-goals

- turning every command into a complex state machine
- blocking harmless workflows that are already deterministic
- replacing prompt guidance entirely; prompts should remain, but enforcement should carry the real safety load

## Dependencies

Recommended after chunk 01 so the guardrails can be measured with evals immediately.
