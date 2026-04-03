---
name: planning
description: Guides collaborative brainstorming, design, and planning — from idea to implementation plan with review gates
---

# Planning Skill

Guide the user through a complete planning flow: brainstorm → design → spec → review → plan. This skill is loaded by `/supi:plan`.

<HARD-GATE>
Do NOT write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Process

Follow these phases in order. Do not skip or combine them.

### Phase 1: Explore Project Context

Before asking questions, understand the current state:

- Check files, docs, recent commits
- Understand existing architecture and patterns
- If the request covers multiple independent subsystems, flag it immediately and help decompose into sub-projects

### Phase 2: Ask Clarifying Questions

- One question at a time — never overwhelm with multiple questions
- Prefer multiple choice when possible, open-ended is fine too
- Focus on: purpose, constraints, success criteria
- Continue until you have enough clarity to propose approaches

### Phase 3: Propose 2-3 Approaches

- Present 2-3 different approaches with trade-offs
- Lead with your recommended option and explain why
- Wait for the user to choose before proceeding

### Phase 4: Present Design

Once aligned on approach:

- Scale each section to its complexity (a few sentences if straightforward, up to 200-300 words if nuanced)
- Cover: architecture, components, data flow, error handling, testing
- Ask after each section whether it looks right so far
- Apply YAGNI ruthlessly — remove unnecessary features
- Design for isolation: smaller units with clear boundaries

### Phase 5: Write Design Doc

Once the user approves the design:

- Save to `.omp/supipowers/specs/YYYY-MM-DD-<topic>-design.md`
- Use clear, concise writing
- Commit the design document to git

### Phase 6: Spec Review Loop

After writing the design doc:

1. Dispatch a spec-document-reviewer sub-agent to verify completeness
2. If **Issues Found**: fix the issues, re-dispatch the reviewer
3. Repeat until **Approved** (max 5 iterations, then surface to human)

### Phase 7: User Review Gate

Ask the user to review the spec before proceeding:

> "Spec written and committed to `<path>`. Please review it and let me know if you want to make any changes before we start writing out the implementation plan."

Wait for their response. Only proceed once approved.

### Phase 8: Create Implementation Plan

Break into bite-sized tasks (2-5 minutes each). Each task must have:

- Name
- **files**: Exact paths the agent will touch
- **criteria**: Acceptance criteria (testable)
- **complexity**: `small` | `medium` | `large`

Include exact code in the plan, not vague descriptions. Use checkbox syntax (`- [ ]`) for tracking steps.

## Plan Structure

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
- **files**: src/path/to/file.ts
- **criteria**: <what success looks like>
- **complexity**: small

- [ ] Step 1: Write the failing test
- [ ] Step 2: Run test to verify it fails
- [ ] Step 3: Write minimal implementation
- [ ] Step 4: Run test to verify it passes
- [ ] Step 5: Commit
```

## Principles

- Each task should be completable in 2-5 minutes
- Include test files in the files list
- Prefer small, focused tasks over large ones
- DRY, YAGNI, TDD, frequent commits
