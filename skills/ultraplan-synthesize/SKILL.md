---
name: ultraplan-synthesize
description: Scenario decomposition stage — produces a complete authored.json and manifest.json draft from all prior pipeline artifacts
---

# UltraPlan Synthesize

Decompose the intake goal into executable scenarios with TDD ownership, slot assignments, and dependency edges. This stage runs after all research artifacts are available. Its output is the plan draft submitted to the review checkers.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Inputs** | Intake + scout + discover + all research artifacts (provided by pipeline runner) |
| **Output** | Authored draft written via `ultraplan_synth_draft` |
| **Scope** | All applicable stacks; every intake success criterion must map to ≥1 scenario |
| **Storage tool** | `ultraplan_synth_draft({ authored, manifest })` — called exactly once |

## Structural Rules

These rules are enforced by the structure-checker. Violating them produces BLOCKER findings.

| Rule | Constraint |
|------|-----------|
| Stack coverage | Every applicable stack has ≥1 domain |
| Domain coverage | Every domain has ≥1 scenario |
| Scenario fields | Every scenario has: `id`, `title`, `level`, `slot`, `steps`, `dependencies` |
| ID uniqueness | All scenario IDs are unique across all stacks and domains |
| Dependency graph | No cycles — if A depends on B, B must not depend on A (directly or transitively) |
| Intake coverage | Every intake success criterion maps to ≥1 scenario (checked by scope-checker) |

## TDD Ownership Rules

These rules are enforced by the tdd-checker. Violating them produces BLOCKER findings.

| Level | Owning slot | Proof obligation |
|-------|-------------|-----------------|
| `unit` | `backend-executor`, `frontend-executor`, or `infrastructure-executor` | Red test committed before implementation |
| `integration` | `backend-tester`, `frontend-tester`, or `infrastructure-tester` | Red test committed; covers cross-boundary behavior |
| `e2e` | `backend-tester`, `frontend-tester`, `infrastructure-tester`, or `*-domain-reviewer` | Red test committed; simulates end-user flow |

Every scenario marked `level: unit` MUST have a `steps` entry that creates and runs a failing test before implementation. Every scenario at `integration` or `e2e` MUST have a `steps` entry that writes and runs the failing test as its first step.

## Decomposition Process

### Step 1 — Map intake success criteria to domains

Group success criteria into logical domains per stack. A domain is a coherent capability boundary (e.g. "authentication", "billing", "data-export"). Avoid single-scenario domains unless the capability genuinely stands alone.

### Step 2 — Decompose each domain into scenarios

A scenario is the smallest independently verifiable unit of work. Split along these seams:
- Happy path vs error path (separate scenarios if the error path requires different test setup)
- Read vs write (if they have independent validation requirements)
- Sync vs async (if they have different timing constraints)

Do not split for its own sake. If two behaviors are always tested together, they belong in one scenario.

### Step 3 — Assign levels and slots

Apply TDD ownership rules. When a scenario touches multiple stacks, assign it to the stack that owns the primary side effect.

### Step 4 — Order dependencies

Mark `dependencies` as a list of scenario IDs that must be complete before this scenario can begin. Use `[]` for no dependencies. Verify there are no cycles.

### Step 5 — Write the draft

Call `ultraplan_synth_draft` exactly once:

```
ultraplan_synth_draft({
  authored: {
    stacks: [
      {
        id: "frontend" | "backend" | "infrastructure",
        domains: [
          {
            id: string,
            name: string,
            scenarios: [
              {
                id: string,
                title: string,
                level: "unit" | "integration" | "e2e",
                slot: string,              // e.g. "backend-executor"
                steps: string[],           // imperative steps; first step writes failing test
                dependencies: string[]     // scenario IDs
              }
            ]
          }
        ]
      }
    ]
  },
  manifest: {
    title: string,
    goal: string,
    successCriteria: string[],
    deferredIdeas: string[]
  }
})
```

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Map every intake success criterion to ≥1 scenario | Generate scenarios with no connection to the intake goal |
| Assign `unit` scenarios to executor slots | Assign `unit` scenarios to tester slots |
| Make the first step of every scenario a failing test | Write implementation steps before a test step |
| Verify no dependency cycles before calling `ultraplan_synth_draft` | Produce a cyclic dependency graph |
| Cover every applicable stack with ≥1 domain | Leave an applicable stack with no scenarios |

## Final Checklist

- [ ] Every intake success criterion maps to ≥1 scenario
- [ ] Every applicable stack has ≥1 domain with ≥1 scenario
- [ ] Every scenario has all required fields
- [ ] All scenario IDs are unique
- [ ] All `unit` scenarios use executor slots; all `integration`/`e2e` use tester or domain-reviewer slots
- [ ] Every scenario's first step creates a failing test
- [ ] Dependency graph is acyclic (verified by inspection)
- [ ] `ultraplan_synth_draft` called exactly once
