---
name: ultraplan-review-tdd
description: TDD ownership correctness checker — verifies executor/tester slot assignments match scenario levels and every scenario's first step is a failing test
---

# UltraPlan Review: TDD Checker

Verify that every scenario is assigned to the correct slot for its test level and that every scenario's step sequence begins with a failing test. This checker runs as part of the review stage.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Inputs** | Draft `authored.json` |
| **Output** | Findings via `ultraplan_review_finding` with `source: "tdd-checker"` |
| **Scope** | Slot-to-level alignment, red-test step presence, proof obligations |
| **Storage tool** | `ultraplan_review_finding` — one call per distinct TDD violation |

## TDD Ownership Rules

| Level | Valid slots | Invalid slots |
|-------|-------------|---------------|
| `unit` | `frontend-executor`, `backend-executor`, `infrastructure-executor` | Any tester or domain-reviewer slot |
| `integration` | `frontend-tester`, `backend-tester`, `infrastructure-tester` | Any executor or domain-reviewer slot |
| `e2e` | `frontend-tester`, `backend-tester`, `infrastructure-tester`, `frontend-domain-reviewer`, `backend-domain-reviewer`, `infrastructure-domain-reviewer` | Any executor slot |

A slot name is invalid for a level if it does not appear in the "Valid slots" column.

## Checks

### Check 1 — Slot-Level Alignment

Every scenario's `slot` MUST be in the valid-slots list for its `level`.

Severity:
- BLOCKER if a `unit` scenario uses a tester or domain-reviewer slot.
- BLOCKER if an `integration` scenario uses an executor or domain-reviewer slot.
- BLOCKER if an `e2e` scenario uses an executor slot.

### Check 2 — Slot-Stack Consistency

The slot's stack prefix MUST match the scenario's containing stack.

- BLOCKER if a scenario in `frontend` stack uses a `backend-*` or `infrastructure-*` slot.
- BLOCKER if a scenario in `backend` stack uses a `frontend-*` or `infrastructure-*` slot.
- BLOCKER if a scenario in `infrastructure` stack uses a `frontend-*` or `backend-*` slot.

### Check 3 — Red-Test Step Presence

Every scenario's `steps` array MUST contain a step that creates and runs a failing test before any implementation step.

Detection: The first step MUST contain language indicating test creation and failure verification. Acceptable signals: "write a failing test", "add a failing test", "run the test and confirm it fails", "commit the red test". Presence of implementation language in the first step without a preceding test step is a violation.

Severity:
- BLOCKER if the first step does not write or run a test.
- BLOCKER if no step in the array runs the test before implementation steps begin.
- WARNING if a step writes a test but does not verify it fails (does not mention "fails", "red", or "failing").

### Check 4 — Proof Obligation Completeness

For `unit` scenarios: the steps MUST include a step that runs the test after implementation and confirms it passes.

For `integration` and `e2e` scenarios: the steps MUST include a step that runs the full test suite for the relevant layer after implementation.

Severity:
- WARNING if no "verify it passes" step exists after implementation.

### Check 5 — No Implementation Before Red Test

No implementation step (writing source code, calling an API, creating a database migration) MUST appear before the first red-test step.

Severity:
- BLOCKER if an implementation step precedes the red-test step.

## Finding Format

```
ultraplan_review_finding({
  id: "tdd-<N>",
  severity: "BLOCKER" | "WARNING",
  source: "tdd-checker",
  target: {
    stack: "<stack-id>",
    domainId: "<domain-id>",
    scenarioId: "<scenario-id>"
  },
  message: string,
  recommendation: string
})
```

Every TDD finding MUST include all three target fields — the violation is always locatable to a specific scenario.

## Process

Run all five checks across every scenario. Do not stop at the first BLOCKER.

### Example Finding — Wrong Slot for Level

```
ultraplan_review_finding({
  id: "tdd-1",
  severity: "BLOCKER",
  source: "tdd-checker",
  target: { stack: "backend", domainId: "auth", scenarioId: "auth-login-unit" },
  message: "Scenario 'auth-login-unit' has level 'unit' but is assigned slot 'backend-tester'. Unit scenarios must use executor slots.",
  recommendation: "Change slot to 'backend-executor'."
})
```

### Example Finding — Missing Red-Test Step

```
ultraplan_review_finding({
  id: "tdd-2",
  severity: "BLOCKER",
  source: "tdd-checker",
  target: { stack: "frontend", domainId: "dashboard", scenarioId: "dashboard-load" },
  message: "Scenario 'dashboard-load' first step is 'Implement the data fetching hook', which is an implementation step. No preceding failing test step exists.",
  recommendation: "Prepend a step: 'Write a failing test for the dashboard data fetching hook and run it to confirm it fails.'"
})
```

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Check every scenario individually | Sample scenarios and extrapolate |
| Apply slot-level rules strictly per the ownership table | Accept executor slots for integration scenarios "because it is simpler" |
| Report slot-stack mismatch separately from slot-level mismatch | Combine into one finding when both violations exist on the same scenario |
| Set all three target fields on every TDD finding | Use null targets for locatable violations |
| Complete all five checks before emitting findings | Stop after discovering Check 1 failures |

## Final Checklist

- [ ] All five checks executed for every scenario
- [ ] Every `unit` scenario uses an executor slot matching its stack
- [ ] Every `integration` scenario uses a tester slot matching its stack
- [ ] Every `e2e` scenario uses a tester or domain-reviewer slot matching its stack
- [ ] Every scenario's first step is a failing test
- [ ] No implementation step precedes the red-test step in any scenario
- [ ] Every finding targets a specific scenario with all three target fields populated
