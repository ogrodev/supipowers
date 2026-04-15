---
name: planning
description: Guides collaborative brainstorming, design, and planning — from idea to implementation plan with review gates
---

# Planning Skill

Guide the user through a complete planning flow: brainstorm → design → spec → review → plan. Loaded by `/supi:plan`.

You **MUST NOT** write code or scaffold until the user approves the design.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| Scope | Single feature or decomposed sub-project |
| Input | User's initial request + repo state (files, docs, commits) |
| Output | Design doc at `.omp/supipowers/specs/YYYY-MM-DD-<topic>-design.md`, implementation plan |
| Phases | Explore → Clarify → Brainstorm → Design & Save → Review Loop → User Gate → Plan |
| Task size | 2–5 minutes each, checkbox syntax |
| Specs | Local only — never commit to git |

## Process

Follow phases in order. Do not skip or combine them.

### Phase 1: Explore Project Context

Before asking questions, understand the current state:

- Check files, docs, recent commits
- Understand existing architecture and patterns
- If the request covers multiple independent subsystems, flag it and help decompose into sub-projects

### Phase 2: Ask Clarifying Questions

Determine the planning mode: problem exploration, solution ideation, assumption testing, or strategy exploration.

- One question at a time — never batch multiple questions
- Prefer multiple choice when possible; open-ended is fine too
- Focus on: purpose, constraints, success criteria, non-goals
- If missing evidence blocks brainstorming, name the research gap explicitly
- Continue until purpose, constraints, success criteria, and non-goals are each addressed

**Example — good vs. bad clarifying question:**

```
BAD (open-ended, unbounded):
"What kind of authentication do you want?"

GOOD (multiple choice, scoped):
"For auth, which fits best?
 a) Session-based (server-rendered, simple)
 b) JWT (stateless, API-first)
 c) OAuth provider only (GitHub/Google, no local accounts)
 d) Something else — describe briefly"
```

### Phase 3: Brainstorm, Then Propose 2–3 Approaches

- Internally generate 5–7 directions before converging
- Pressure-test with: one opposite option, one simplification/removal, one cross-domain analogy
- Name traps when they appear: solutioning too early, one-idea brainstorm, analysis paralysis
- Present only the strongest 2–3 approaches with trade-offs
- Lead with your recommended option and explain why
- For the leading option, capture the biggest unknown and the cheapest validation step
- Wait for the user to choose before proceeding

**Example — brainstorm output format:**

```
### Approaches

**A) Event-sourced (recommended)**
- How: Append-only event log, projections for read models
- Pro: Full audit trail, temporal queries
- Con: Higher upfront complexity, eventual consistency
- Biggest unknown: Event schema evolution strategy
- Cheapest validation: Spike a single aggregate with 3 events

**B) Traditional CRUD + audit table
- How: Mutable rows, trigger-based audit log
- Pro: Familiar, immediate consistency
- Con: Audit coverage depends on discipline, no temporal queries

**C) Hybrid — CRUD with event log for critical paths
- How: Standard CRUD; event-source only billing and permissions
- Pro: Complexity only where value is highest
- Con: Two persistence patterns to maintain
```

### Phase 4: Present Design & Save

Once aligned on approach:

- Cover: architecture, components, data flow, error handling, testing strategy
- Scale sections by integration points: ≤2 integration points → 2–3 sentences; 3+ → up to 300 words
- Ask after each section whether it looks right so far
- Apply YAGNI — cut features that aren't required now
- Design for isolation: smaller units with clear boundaries
- Prefer DRY, TDD

Once approved, save to `.omp/supipowers/specs/YYYY-MM-DD-<topic>-design.md`. Keep local — do not commit to git.

### Phase 5: Spec Review Loop

1. Dispatch a spec-document-reviewer sub-agent to verify completeness
2. If **Issues Found**: fix the issues, re-dispatch the reviewer
3. Repeat until **Approved** (max 5 iterations; after 5, present remaining issues to user and ask whether to proceed or continue fixing)

### Phase 6: User Review Gate

> "Spec written to `<path>`. Please review it and let me know if you want changes before we write the implementation plan."

Wait for approval. Only proceed once approved.

### Phase 7: Create Implementation Plan

Break into tasks of 2–5 minutes each. Each task must have:

- Name
- **files**: exact paths the agent will touch (include test files)
- **criteria**: acceptance criteria (testable)
- **complexity**: `small` | `medium` | `large`

Steps use checkbox syntax (`- [ ]`). Describe what each step changes in prose. Include function signatures or brief pseudocode only when they clarify a non-obvious interface or algorithm. Do NOT include full function bodies, full test bodies, or file-content dumps — the plan describes the work, the execution session writes the code.

**Plan template:**

```
---
name: <feature-name>
created: <YYYY-MM-DD>
tags: [<relevant>, <tags>]
---

# <Feature Name>

## Context
<What this plan accomplishes and why>

## Tasks

### 1. <Task name>
- **files**: src/path/to/file.ts, src/path/to/file.test.ts
- **criteria**: <what success looks like>
- **complexity**: small

- [ ] Step 1: Write the failing test
- [ ] Step 2: Run test to verify it fails
- [ ] Step 3: Write minimal implementation
- [ ] Step 4: Run test to verify it passes
```

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| One question at a time in Phase 2 | Write code before design approval |
| Present 2–3 approaches with trade-offs | Skip brainstorming for "obvious" solutions |
| Wait for user approval at each gate | Combine or skip phases |
| Include test files in task file lists | Include git commit/push steps for specs |
| Name research gaps instead of guessing | Present every explored branch (show finalists only) |
| Describe steps in prose with optional signatures | Include full function bodies, test bodies, or file contents in plans |

## Final Checklist

- [ ] All phases followed in order
- [ ] Purpose, constraints, success criteria, and non-goals addressed in Phase 2
- [ ] 2–3 approaches presented with trade-offs before design
- [ ] Design doc saved to `.omp/supipowers/specs/` (not committed)
- [ ] Spec review loop completed (sub-agent approved or user overrode)
- [ ] User approved spec before implementation plan
- [ ] Every task has files, criteria, complexity, and checkbox steps
- [ ] Task steps describe changes in prose; signatures/pseudocode used only when they clarify non-obvious interfaces
- [ ] No full function bodies, test bodies, or file-content dumps in the plan
