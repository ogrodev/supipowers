---
name: ultraplan-review-structure
description: Structural integrity checker — verifies every applicable stack has domains and scenarios, all fields are present, IDs are unique, and the dependency graph is acyclic
---

# UltraPlan Review: Structure Checker

Verify the structural integrity of a synthesized draft. This checker runs as part of the review stage. It does not evaluate correctness of content — it verifies that the shape of the plan satisfies the invariants required for execution.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Inputs** | Draft `authored.json`; intake artifact (to know which stacks are applicable) |
| **Output** | Findings via `ultraplan_review_finding` with `source: "structure-checker"` |
| **Scope** | Shape, presence, uniqueness, and graph constraints only |
| **Storage tool** | `ultraplan_review_finding` — one call per distinct structural violation |

## Checks

### Check 1 — Stack Coverage

Every stack marked `applicable` in the intake MUST appear in `authored.stacks` with at least one domain.

- BLOCKER if an applicable stack is absent from `authored.stacks`.
- BLOCKER if an applicable stack is present but has zero domains.
- WARNING if a stack marked `unknown` in the intake is absent (the planner may have determined it is not needed, but should confirm).

### Check 2 — Domain Coverage

Every domain in every stack MUST have at least one scenario.

- BLOCKER if a domain has zero scenarios.

### Check 3 — Required Scenario Fields

Every scenario MUST have all of: `id`, `title`, `level`, `slot`, `steps`, `dependencies`.

- BLOCKER if any field is missing or null on any scenario.
- BLOCKER if `steps` is an empty array.
- BLOCKER if `level` is not one of `unit`, `integration`, `e2e`.
- BLOCKER if `dependencies` is absent (empty array `[]` is valid).

### Check 4 — ID Uniqueness

All scenario IDs across all stacks and domains MUST be globally unique.

- BLOCKER if any two scenarios share the same `id`.

### Check 5 — Dependency Graph Validity

For every scenario that lists dependencies:
- Each dependency ID MUST resolve to an existing scenario.
- The graph MUST be acyclic.

Detection algorithm: perform a depth-first traversal from each scenario. If you encounter a node already on the current path, a cycle exists.

- BLOCKER if a dependency ID does not resolve to an existing scenario.
- BLOCKER if a cycle is detected. Report all scenario IDs in the cycle in the `message`.

### Check 6 — Slot Presence

Every `slot` value on every scenario MUST be a non-empty string.

- BLOCKER if `slot` is empty, null, or whitespace.

## Finding Format

```
ultraplan_review_finding({
  id: "struct-<N>",
  severity: "BLOCKER" | "WARNING",
  source: "structure-checker",
  target: {
    stack: "<stack-id>" | null,
    domainId: "<domain-id>" | null,
    scenarioId: "<scenario-id>" | null
  },
  message: string,          // what is structurally wrong and where
  recommendation: string    // what to add, fix, or remove
})
```

Set `target` fields to the most specific level at which the violation occurs. If a stack is missing entirely, `domainId` and `scenarioId` are null.

## Process

Run all six checks in order. Do not stop at the first BLOCKER — complete all checks and emit all findings.

### Example Finding — Missing Required Field

```
ultraplan_review_finding({
  id: "struct-1",
  severity: "BLOCKER",
  source: "structure-checker",
  target: { stack: "backend", domainId: "auth", scenarioId: "auth-login-happy" },
  message: "Scenario 'auth-login-happy' in backend/auth is missing the 'slot' field.",
  recommendation: "Add a slot value matching the TDD ownership rules, e.g. 'backend-executor' for unit-level scenarios."
})
```

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Check all six structural invariants | Stop checking after the first BLOCKER |
| Report every violation as a separate finding | Batch multiple violations into one finding |
| Detect and report all cycle participants | Report only one node in a cycle |
| Set `target` to the most specific location | Use null targets when a specific location is available |
| Complete all checks even if count of findings is high | Skip checks to reduce finding volume |

## Final Checklist

- [ ] All six checks executed
- [ ] Every applicable stack verified for domain coverage
- [ ] ID uniqueness verified across all stacks globally
- [ ] Dependency graph traversed for cycles
- [ ] Every finding has a specific `target` and actionable `recommendation`
- [ ] Zero findings explicitly recorded if no violations found (emit no calls, do not suppress output)
