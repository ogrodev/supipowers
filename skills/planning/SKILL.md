---
name: planning
description: Guides collaborative planning and task breakdown for implementation
---

# Planning Skill

Guide the user through planning an implementation. This skill is loaded by `/supi:plan`.

## Process

1. **Understand**: Ask one clarifying question at a time. Prefer multiple choice.
2. **Propose**: Offer 2-3 approaches with trade-offs and your recommendation.
3. **Break down**: Generate bite-sized tasks with clear boundaries.

## Task Format

Each task must have:
- Name with parallelism: `[parallel-safe]` or `[sequential: depends on N]`
- **files**: Exact paths the agent will touch
- **criteria**: Acceptance criteria (testable)
- **complexity**: `small` | `medium` | `large`

## Plan Structure

Use this template:

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

### 1. <Task name> [parallel-safe]
- **files**: src/path/to/file.ts
- **criteria**: <what success looks like>
- **complexity**: small
```

## Principles

- Each task should be completable in 2-10 minutes
- Tasks that touch different files are parallel-safe
- Tasks that depend on others' output are sequential
- Include test files in the files list
- Prefer small, focused tasks over large ones
