---
name: creating-supi-agents
description: Interactive guide for creating a new supipowers review agent from scratch
---

# Creating a Review Agent

Guide the user through creating a specialized code review agent for supipowers' multi-agent `/supi:review` pipeline.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Input** | User's description of what the agent should review |
| **Output** | Agent file saved to `.omp/agents/<agent-name>.md` |
| **File format** | YAML frontmatter (`name`, `description`, `focus`) + prompt body + `{output_instructions}` |
| **Hard constraint** | Prompt body **MUST** end with `{output_instructions}` on its own line — the pipeline replaces it with the output schema at review time |
| **Process** | Goal → Research → Present → Refine → Save |

## Agent File Format

```markdown
---
name: <kebab-case-name>
description: <one-line summary>
focus: <comma-separated areas>
---

<prompt body>

{output_instructions}
```

## Process

### Step 1: Understand the Goal

Ask what kind of reviewer the user wants. Common archetypes:

| Archetype | Focus areas |
|-----------|-------------|
| Performance | algorithmic complexity, memory, caching, lazy loading |
| Accessibility | ARIA, semantic HTML, screen reader support, WCAG |
| API design | REST conventions, error contracts, versioning |
| Test quality | coverage gaps, flaky patterns, missing edge cases |
| Security | injection, auth, secrets, OWASP Top 10 |
| Documentation | JSDoc, README accuracy, changelog updates |

### Step 2: Research

Research established checklists and best practices for the focus area (e.g., OWASP for security, WCAG for accessibility). Look for language/framework-specific patterns relevant to the user's stack.

### Step 3: Present Overview

Present a structured proposal:
- **Name**: suggested kebab-case name
- **Description**: one-line summary
- **Focus areas**: comma-separated specializations
- **Review criteria**: bulleted list of what the agent will check
- **Example findings**: 2–3 examples of what this agent would flag

### Step 4: Refine with User

Ask if they want to adjust:
- Focus areas or review criteria
- Tone — **strict** (flags aggressively, treats ambiguity as an issue) vs. **advisory** (flags only clear problems, uses softer language)
- Project-specific conventions to enforce

Iterate until the user approves.

### Step 5: Save the Agent

Generate the final agent file and save to `.omp/agents/<agent-name>.md`.

## Agent Prompt Guidelines

### What makes a good agent prompt

1. **State the role** clearly (e.g., "You are a performance-focused code reviewer")
2. **List specific check items** as concrete, actionable criteria (not vague categories)
3. **Provide severity guidance** — define what warrants `error` vs. `warning` vs. `info`
4. **Define scope boundaries** — state what is NOT in scope to prevent overlap with other agents
5. **End with `{output_instructions}`** — mandatory, on its own line

### Before / After: Check Item Quality

```markdown
# BEFORE — vague
## What to Check
- Look for performance issues
- Check if things could be faster
- Make sure the code is efficient

# AFTER — concrete and actionable
## What to Check
- **Algorithmic complexity**: O(n²) or worse loops, unnecessary nested iterations
- **Memory allocation**: Large object creation in hot paths, missing cleanup
- **Caching opportunities**: Repeated expensive computations that could be memoized
```

### Before / After: Severity Guidance

```markdown
# BEFORE — missing severity
Flag any issues you find in the code.

# AFTER — calibrated severity
## Severity Guide
- **error**: Will cause visible degradation in production (e.g., O(n²) on large datasets)
- **warning**: Potential issue that depends on scale (e.g., missing memoization)
- **info**: Optimization opportunity, not a current problem
```

## Example: Performance Agent

```markdown
---
name: performance
description: Reviews code for performance issues and optimization opportunities
focus: algorithmic complexity, memory allocation, caching, lazy loading
---

You are a performance-focused code reviewer. Analyze the provided code diff for performance issues.

## What to Check

- **Algorithmic complexity**: O(n²) or worse loops, unnecessary nested iterations
- **Memory allocation**: Large object creation in hot paths, missing cleanup
- **Caching opportunities**: Repeated expensive computations that could be memoized
- **Lazy loading**: Resources loaded eagerly that could be deferred
- **Bundle size**: Unnecessary imports, tree-shaking blockers
- **Database queries**: N+1 queries, missing indexes, unbounded result sets

## Severity Guide

- **error**: Will cause visible performance degradation in production (e.g., O(n²) on large datasets)
- **warning**: Potential issue that depends on scale (e.g., missing memoization)
- **info**: Optimization opportunity, not a current problem

## Out of Scope

- Correctness issues (handled by correctness agent)
- Style/formatting (handled by linter)
- Security concerns (handled by security agent)

{output_instructions}
```

## Example: Accessibility Agent

```markdown
---
name: accessibility
description: Reviews UI code for accessibility violations and WCAG compliance
focus: ARIA attributes, semantic HTML, keyboard navigation, color contrast
---

You are an accessibility-focused code reviewer. Analyze the provided code diff for accessibility issues using WCAG 2.1 AA as the baseline.

## What to Check

- **Semantic HTML**: `<div>` or `<span>` used where `<button>`, `<nav>`, `<main>`, `<section>` belongs
- **ARIA attributes**: Missing `aria-label` on icon-only buttons, incorrect `role` values
- **Keyboard navigation**: Interactive elements not reachable via Tab, missing focus indicators
- **Color contrast**: Text/background combinations below 4.5:1 ratio (normal text) or 3:1 (large text)
- **Form labels**: Inputs without associated `<label>` or `aria-labelledby`
- **Image alt text**: Missing or non-descriptive `alt` attributes on `<img>` tags

## Severity Guide

- **error**: Blocks assistive technology users entirely (e.g., button with no accessible name)
- **warning**: Degraded experience for assistive technology users (e.g., missing focus indicator)
- **info**: Best-practice improvement (e.g., prefer `<nav>` over `<div role="navigation">`)

## Out of Scope

- Visual design preferences (handled by design review)
- Performance (handled by performance agent)
- Business logic correctness (handled by correctness agent)

{output_instructions}
```

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| End every agent prompt with `{output_instructions}` on its own line | Omit `{output_instructions}` — the pipeline will fail |
| Include a severity guide (`error` / `warning` / `info`) | Leave severity undefined — agents produce inconsistent ratings |
| Define "Out of Scope" to prevent overlap with other agents | Let scope overlap — produces duplicate findings across agents |
| Use concrete check items with specific patterns to look for | Use vague criteria like "check for issues" or "ensure quality" |
| Save to `.omp/agents/<agent-name>.md` | Save anywhere else or leave unsaved |

## Pre-Save Checklist

Before saving the agent file, verify:

- [ ] YAML frontmatter has `name`, `description`, and `focus`
- [ ] Prompt body states the agent's role in the first sentence
- [ ] At least 3 concrete, actionable check items
- [ ] Severity guide defines `error`, `warning`, and `info` thresholds
- [ ] "Out of Scope" section present
- [ ] `{output_instructions}` is the last line of the prompt body
- [ ] File saved to `.omp/agents/<agent-name>.md`
