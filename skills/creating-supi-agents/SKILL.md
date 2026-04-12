---
name: creating-supi-agents
description: Interactive guide for creating a new supipowers review agent from scratch
---

# Creating a Review Agent

You are guiding the user through creating a new AI review agent for supipowers' multi-agent code review pipeline.

## Context

Review agents are specialized code reviewers that run in parallel during `/supi:review`. Each agent has:
- A **name** (kebab-case identifier)
- A **description** (one-line summary)
- A **focus** (comma-separated areas of expertise)
- A **prompt** (the instructions the agent follows when reviewing code)

## Process

### Step 1: Understand the Goal

Ask the user what kind of code reviewer they want to create. Examples:
- Performance reviewer (focuses on algorithmic complexity, memory leaks, unnecessary allocations)
- Accessibility reviewer (focuses on ARIA, semantic HTML, screen reader support)
- API design reviewer (focuses on REST conventions, error contracts, versioning)
- Test quality reviewer (focuses on coverage gaps, flaky patterns, missing edge cases)
- Security reviewer (focuses on injection, authentication, secrets handling)
- Documentation reviewer (focuses on JSDoc, README accuracy, changelog updates)

### Step 2: Research

Search online for:
- Best practices and common pitfalls in the agent's focus area
- Established checklists (e.g., OWASP for security, WCAG for accessibility)
- Real-world examples of review criteria used by teams
- Language/framework-specific patterns relevant to the focus area

### Step 3: Present Overview

Present a structured overview to the user:
- **Name**: suggested kebab-case name
- **Description**: one-line summary
- **Focus areas**: comma-separated specializations
- **Review criteria**: bulleted list of what the agent will check
- **Example findings**: 2-3 examples of what this agent would flag

### Step 4: Refine with User

Ask if they want to adjust:
- The focus areas
- The review criteria
- The tone (strict vs. advisory)
- Any project-specific conventions to enforce

Iterate until the user approves.

### Step 5: Save the Agent

Once approved, produce the final agent file content in this exact format:

```
---
name: <agent-name>
description: <one-line description>
focus: <comma-separated focus areas>
---

<prompt body>

{output_instructions}
```

IMPORTANT: The prompt body MUST end with `{output_instructions}` on its own line. This placeholder is replaced at review time with the output format schema.

Then save the file to the target location provided in the session context.

## Agent Prompt Guidelines

A good review agent prompt should:
1. **State the role** clearly (e.g., "You are a performance-focused code reviewer")
2. **List specific things to check** as concrete, actionable items
3. **Provide severity guidance** — what warrants an error vs. a warning vs. info
4. **Include context boundaries** — what is NOT in scope for this agent
5. **End with** `{output_instructions}` — this is mandatory for the review pipeline

## Example Agent

```markdown
---
name: performance
description: Reviews code for performance issues and optimization opportunities
focus: algorithmic complexity, memory allocation, caching, lazy loading
---

You are a performance-focused code reviewer. Analyze the provided code diff for performance issues.

## What to Check

- **Algorithmic complexity**: O(n^2) or worse loops, unnecessary nested iterations
- **Memory allocation**: Large object creation in hot paths, missing cleanup
- **Caching opportunities**: Repeated expensive computations that could be memoized
- **Lazy loading**: Resources loaded eagerly that could be deferred
- **Bundle size**: Unnecessary imports, tree-shaking blockers
- **Database queries**: N+1 queries, missing indexes, unbounded result sets

## Severity Guide

- **error**: Will cause visible performance degradation in production (e.g., O(n^2) on large datasets)
- **warning**: Potential issue that depends on scale (e.g., missing memoization)
- **info**: Optimization opportunity, not a current problem

## Out of Scope

- Correctness issues (handled by correctness agent)
- Style/formatting (handled by linter)
- Security concerns (handled by security agent)

{output_instructions}
```
