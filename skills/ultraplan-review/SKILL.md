---
name: ultraplan-review
description: Generic plan-review framing — what each checker catches, severity semantics, and the revision contract
---

# UltraPlan Review

Apply one or more plan checkers to a synthesized draft. This stage runs after synthesize and gates the approve stage. It produces structured findings that either block promotion or pass the draft through.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Inputs** | Current draft (`authored.json` + `manifest.json`); iteration number; prior findings if revising |
| **Output** | Findings written via `ultraplan_review_finding` (one call per finding) |
| **Checkers** | `structure-checker`, `scope-checker`, `tdd-checker` |
| **Gate** | Zero BLOCKER findings required to advance to approve |
| **Loop** | If BLOCKERs remain after revision, the pipeline returns to synthesize |

## Checker Responsibilities

| Checker | What It Catches |
|---------|----------------|
| `structure-checker` | Missing stacks, missing domains, missing scenario fields, duplicate IDs, dependency cycles |
| `scope-checker` | Uncovered intake success criteria, scope creep, silently included deferred ideas |
| `tdd-checker` | Wrong slot for level, missing red-test step, missing proof obligations |

## Severity Semantics

| Severity | Meaning | Gate |
|----------|---------|------|
| `BLOCKER` | The plan cannot be executed correctly as written. The synthesize stage MUST revise before re-review. | Blocks approve |
| `WARNING` | The plan can execute, but a quality or coverage gap exists. The planner SHOULD fix, but approve MAY proceed. | Does not block |

Use BLOCKER only when execution would fail, produce wrong output, or violate a structural invariant. Use WARNING for coverage gaps, missing evidence, or best-practice deviations that do not break execution.

## Finding Format

Each `ultraplan_review_finding` call produces one finding:

```
ultraplan_review_finding({
  id: string,                  // unique within this iteration, e.g. "s1-missing-unit-slot"
  severity: "BLOCKER" | "WARNING",
  source: "structure-checker" | "scope-checker" | "tdd-checker",
  target: {
    stack: "frontend" | "backend" | "infrastructure" | null,
    domainId: string | null,
    scenarioId: string | null
  },
  message: string,             // what is wrong
  recommendation: string       // concrete fix the planner can act on
})
```

The `message` MUST identify the exact location (stack, domain, scenario ID when applicable). The `recommendation` MUST be actionable — say what to add, remove, or change.

## Revision Contract

When the pipeline returns to synthesize with findings:
- The planner receives all findings from the current iteration.
- The planner MUST address every BLOCKER. Ignoring a BLOCKER and resubmitting is a stall.
- The planner MAY address WARNINGs at its discretion.
- After revision, `ultraplan_synth_draft` is called again and the review stage re-runs on the new draft.
- Iteration count increments on each revision cycle.

## Running Multiple Checkers

Each checker runs independently and writes its own findings. The pipeline runner aggregates all findings for the iteration. You MUST run all three checkers even if the first checker finds BLOCKERs — partial checker output is not useful for the planner.

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Run all three checkers every iteration | Stop after the first BLOCKER |
| Target every finding to a specific location | Emit vague findings without stack/domain/scenario |
| Use BLOCKER only for structural or execution failures | Escalate style or preference issues to BLOCKER |
| Provide an actionable recommendation for every finding | Report a finding without a fix direction |
| Call `ultraplan_review_finding` once per distinct issue | Batch multiple issues into one finding |

## Final Checklist

- [ ] All three checkers ran and produced output (or explicitly recorded zero findings)
- [ ] Every BLOCKER has a specific target and an actionable recommendation
- [ ] No finding conflates multiple issues
- [ ] Iteration number is correct for this review cycle
