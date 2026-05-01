---
name: ultraplan-discover
description: Gray-area extraction stage — surfaces decisions the user must make before the plan can be authored, without expanding scope
---

# UltraPlan Discover

Identify the open decisions and ambiguities that block confident scenario authoring. This stage mirrors the GSD discuss phase. It runs after scout and before research. Its sole output is a set of decision records and, optionally, deferred-idea records.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Inputs** | Intake artifact + scout artifact (provided by pipeline runner) |
| **Output** | One `ultraplan_decision_record` call per decision area; deferred ideas via the same tool with `deferred: true` |
| **Scope** | Identification only — no library selection, no scenario generation |
| **Scope guardrail** | You MUST NOT expand scope beyond what the intake goal states |
| **Storage tools** | `ultraplan_decision_record` — one call per area |

## Decision Areas

A decision area is any ambiguity that, if resolved differently, would materially change the plan's scenarios, slots, or test architecture. Examples:

| Category | Example Questions |
|----------|------------------|
| Auth strategy | Session vs JWT vs OAuth provider — which applies? |
| API shape | REST vs GraphQL vs RPC — does the intake imply a choice? |
| Error semantics | Should errors surface to the UI or be swallowed silently? |
| Library choice | Is there an existing library in the scout, or is a new one needed? |
| Data ownership | Which service owns the canonical record? |
| Deployment target | Is this cloud-agnostic, or tied to a specific provider? |
| Test boundary | Should integration tests hit a real database or a test double? |

## Classify Each Area

For each area you identify, assign a disposition:

- **OPEN**: The intake and scout provide no signal. The user must decide before authoring proceeds.
- **RESOLVED-BY-SCOUT**: The scout found an existing pattern that answers the question. Record what was found.
- **RESOLVED-BY-INTAKE**: The intake stated or clearly implied an answer. Record the answer.
- **DEFERRED**: The question is out of scope for this session. Record with `deferred: true`.

Only OPEN areas require user input. RESOLVED areas are recorded for downstream stages to use as constraints.

## Scope Guardrail

You MUST NOT add new requirements, features, or capabilities not present in the intake. If a discovery area reveals an attractive extension, record it with `deferred: true` and move on. The goal statement in the intake is the boundary.

## Process

### Step 1 — Read intake goal and success criteria

Anchor every decision area to a field in the intake. If an area cannot be linked to the intake goal, it is out of scope.

### Step 2 — Read scout findings per stack

For each applicable stack, check whether the scout already resolved the area. Mark accordingly.

### Step 3 — Record each area

Call `ultraplan_decision_record` once per area:

```
ultraplan_decision_record({
  area: string,                          // short label, e.g. "auth-strategy"
  category: string,                      // one of: auth, api-shape, error-semantics,
                                         //   library-choice, data-ownership, deployment, test-boundary, other
  disposition: "OPEN" | "RESOLVED-BY-SCOUT" | "RESOLVED-BY-INTAKE" | "DEFERRED",
  question: string,                      // the specific question to answer
  resolution: string | null,             // null when OPEN; the answer when RESOLVED or DEFERRED
  deferred: boolean,                     // true when disposition is DEFERRED
  affectedStacks: ("frontend" | "backend" | "infrastructure")[]
})
```

### Step 4 — Verify scope

Before finishing, confirm: do all recorded areas trace to the intake goal? If any do not, mark them DEFERRED.

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Link every area to the intake goal | Introduce requirements not in the intake |
| Record RESOLVED areas even when no user input is needed | Skip an area because it seems obvious |
| Mark attractive extensions as DEFERRED | Silently fold deferred ideas into the plan |
| Call `ultraplan_decision_record` once per area | Batch multiple areas into one call |
| Consult scout findings before marking an area OPEN | Ask the user to resolve something the scout already answered |

## Final Checklist

- [ ] Every identified area has a `ultraplan_decision_record` call
- [ ] All RESOLVED areas cite the intake field or scout finding that resolves them
- [ ] All out-of-scope ideas recorded with `deferred: true`
- [ ] No new requirements introduced beyond the intake goal
- [ ] No clarifying questions sent to the user
