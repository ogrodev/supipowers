# Failure Mining

Turn observed AI-heavy workflow failures into concrete hardening work. This
document is the Phase 8 discipline that closes the loop from "a workflow
went wrong" to "the regression can never recur".

## Inputs

- Per-cwd reliability records at `.omp/supipowers/reliability/events.jsonl`
  (`src/storage/reliability-metrics.ts`)
- Persisted session artifacts under `.omp/supipowers/reviews/`,
  `.omp/supipowers/qa-sessions/`, `.omp/supipowers/fix-pr-sessions/`
- Debug traces under `.omp/supipowers/debug/` when `SUPI_DEBUG` is set
- `src/discipline/failure-taxonomy.ts` (classification rules)
- `src/discipline/failure-summarizer.ts` (aggregation + report)
- `src/commands/status.ts` and `src/commands/doctor.ts` (user-facing summary)

## Loop

1. **Collect.** Every AI-heavy workflow emits a `ReliabilityRecord` per
   attempt. Summaries surface in `/supi:status` and `/supi:doctor`.
2. **Classify.** `summarizeLocalFailures(paths, cwd)` folds each non-ok
   record into a `FailureClass` (or into the `unclassified` bucket).
3. **Promote.** Every recurring failure class (count >= 2 within a review
   window) MUST map to one of the four follow-ups below.
4. **Freeze.** The follow-up becomes a merged change on main. The
   originating failure class is no longer anecdotal.

## Follow-up rule

Every recurring failure class maps to exactly one of these follow-ups:

| Class                    | Follow-up                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `premature-completion`   | **Runtime guardrail** in `src/discipline/workflow-invariants.ts` + a behavior eval.        |
| `wrong-tool-path`        | **Tool contract fix**: tighten description / schema / `promptGuidelines` in the tool registration; add a Phase 0-style eval. |
| `missing-artifact`       | **Runtime guardrail** using `requireArtifact()` + behavior eval asserting the artifact exists before completion. |
| `verification-skipped`   | **Runtime guardrail** using `requireCondition()` against the verification outcome + behavior eval. |
| `discovery-miss`         | **Discovery integration**: widen the `src/discovery/` sources the workflow consumes, or surface candidates earlier. |
| `unproductive-retry`     | **Prompt simplification** + schema tightening. Reduce retry cost or make the schema less ambiguous. |

If a recurring failure class does not fit any row above, it is a sign the
taxonomy is incomplete. Extend `FAILURE_CLASSES` and add classification
rules in `src/discipline/failure-taxonomy.ts` before choosing a follow-up.

## Writing the eval

The simplest durable regression gate is a Phase 0-style eval under
`tests/evals/`. Use `defineEval({ name, summary, regressionClass, run })`
from `tests/evals/harness.ts`. Every eval must:

- Document the regression class it catches in a top-of-file comment
- Assert against tool registrations, hook handlers, persisted files, or
  sendMessage payloads — not prompt prose
- Fail deterministically when the invariant is broken

An eval that currently fails is a valid regression gate. Mark it with a
`// FIX-VIA: <phase-or-task-id>` comment so reviewers can trace when the
guardrail is scheduled to land.

## Proving case

`tests/evals/fix-pr-blocks-complete-with-unresolved-selected-comments.test.ts`
is the proving case mined from the `premature-completion` / `missing-artifact`
classes. The eval asserts `/supi:fix-pr` has a completion-gate code path
that blocks marking work complete while unresolved selected-target comments
remain. It currently fails and carries a `FIX-VIA` annotation pointing at
the future fix-pr completion-blocker work. When that blocker lands the
eval flips to passing without changes.

## Anti-patterns

- **Collecting metrics without acting on them.** Every review window
  produces at most one follow-up per class. Ignored classes accumulate.
- **Shipping a prompt-only "fix".** If the taxonomy class has a runtime
  guardrail row in the table above, the follow-up is the guardrail — not
  more prompt prose.
- **Single-run reactions.** A single failure is not evidence of a recurring
  class. Wait for the second occurrence before opening a follow-up.

## Checklist for a mined-failure follow-up

Before merging a fix for a mined failure, confirm:

- [ ] The failure class is in `FAILURE_CLASSES` (or the taxonomy was
      extended)
- [ ] The follow-up matches the corresponding row in the rule table
- [ ] A behavior eval exists under `tests/evals/` and names the regression
      class in a top comment
- [ ] The eval either passes on main now, OR fails with a `FIX-VIA`
      comment pointing at the scheduled guardrail
- [ ] `/supi:doctor` shows the reliability summary that motivated the fix
