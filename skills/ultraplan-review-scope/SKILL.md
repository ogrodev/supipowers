---
name: ultraplan-review-scope
description: Requirement coverage checker — verifies every intake success criterion maps to a scenario, no scope creep exists, and deferred ideas are not silently included
---

# UltraPlan Review: Scope Checker

Verify that the draft covers what was promised and nothing more. This checker runs as part of the review stage. It does not verify structural validity — it verifies semantic alignment between the intake artifact and the draft scenarios.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Inputs** | Draft `authored.json`; intake artifact (goal, success criteria, deferred ideas) |
| **Output** | Findings via `ultraplan_review_finding` with `source: "scope-checker"` |
| **Scope** | Coverage, creep, and deferred-idea containment only |
| **Storage tool** | `ultraplan_review_finding` — one call per distinct scope violation |

## Checks

### Check 1 — Success Criterion Coverage

Every success criterion listed in the intake artifact MUST map to at least one scenario in the draft. A scenario maps to a criterion when its `title` or `steps` directly address the criterion's stated outcome.

Coverage mapping rules:
- Exact keyword overlap is sufficient evidence.
- If a criterion is broad (e.g. "users can manage their profile"), look for at least one scenario per meaningful sub-action implied by the criterion.
- If coverage is ambiguous, record a WARNING rather than a BLOCKER.

Severity:
- BLOCKER if a success criterion has zero scenario coverage.
- WARNING if coverage exists but appears partial (one scenario covers a criterion that clearly implies multiple distinct behaviors).

### Check 2 — Scope Creep

Every scenario in the draft MUST trace to either a success criterion or a structural necessity (e.g. a required setup step that enables a criterion). A scenario with no traceable link to any intake criterion is scope creep.

Severity:
- WARNING if a scenario cannot be traced to any intake criterion or structural necessity.
- BLOCKER if a scenario introduces a capability explicitly outside the intake goal (e.g. intake said "read-only dashboard" but a scenario writes data).

### Check 3 — Deferred Idea Containment

Every idea listed in the intake's `deferredIdeas` array MUST NOT appear as a scenario in the draft. Matching is by semantic similarity, not exact string match.

Severity:
- BLOCKER if a deferred idea appears as a scenario, regardless of how it is named.

### Check 4 — Goal Alignment

The draft's `manifest.goal` MUST match the intake's `goal`. Paraphrasing is acceptable; omitting or expanding the goal is not.

Severity:
- WARNING if the manifest goal is a paraphrase that preserves intent.
- BLOCKER if the manifest goal omits a key constraint from the intake goal.
- BLOCKER if the manifest goal adds capabilities not present in the intake goal.

## Finding Format

```
ultraplan_review_finding({
  id: "scope-<N>",
  severity: "BLOCKER" | "WARNING",
  source: "scope-checker",
  target: {
    stack: "<stack-id>" | null,
    domainId: "<domain-id>" | null,
    scenarioId: "<scenario-id>" | null
  },
  message: string,
  recommendation: string
})
```

For Check 1 failures, set `target.stack`, `target.domainId`, `target.scenarioId` all to null (the gap is at the criteria level, not the scenario level).
For Check 2 and 3 failures, target the specific scenario that introduces creep.

## Process

Run all four checks in order. Complete all checks before stopping.

### Example Finding — Uncovered Criterion

```
ultraplan_review_finding({
  id: "scope-1",
  severity: "BLOCKER",
  source: "scope-checker",
  target: { stack: null, domainId: null, scenarioId: null },
  message: "Intake success criterion 'Users can export their data as CSV' has no matching scenario in the draft.",
  recommendation: "Add a scenario in the relevant stack/domain that covers the CSV export behavior."
})
```

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Check every intake success criterion individually | Assume a broad scenario implicitly covers all sub-behaviors |
| Check every draft scenario for traceability | Only check scenarios that look suspicious |
| Match deferred ideas semantically, not just by exact string | Miss a deferred idea because its scenario uses different wording |
| Report Check 1 gaps at the criteria level (null target) | Target a scenario when the violation is a missing scenario |
| Complete all four checks before emitting findings | Stop after the first BLOCKER |

## Final Checklist

- [ ] Every intake success criterion checked for coverage
- [ ] Every draft scenario checked for traceability
- [ ] All deferred ideas checked against draft scenarios
- [ ] Manifest goal compared against intake goal
- [ ] Every finding targets the correct level (criteria vs scenario)
