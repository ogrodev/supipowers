---
name: ultraplan-research
description: Per-stack research stage — produces library choices, established patterns, pitfalls, and test architecture for one applicable stack
---

# UltraPlan Research

Produce a research artifact for a single assigned stack. This stage is spawned once per applicable stack. It runs after discover and before synthesize. Outputs are consumed by the synthesize stage to ground scenario authoring in observable evidence.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Inputs** | Intake + scout + discover artifacts; the assigned stack identifier (`frontend`, `backend`, or `infrastructure`) |
| **Output** | Research artifact written via `ultraplan_research_record` |
| **Tools** | `web_search`, `read`, `search`, `find` |
| **Scope** | The assigned stack only — do not research other stacks |
| **Storage tool** | `ultraplan_research_record` — called exactly once |

## Research Areas

### 1. Library and Framework Choices

- Start from the scout's `reusableAssets` and package manifest. Prefer what is already installed.
- For each capability gap identified in the discover decisions, determine the best-fit library.
- Use `web_search` to confirm current versions, security advisories, and API stability.
- For each choice, record the reasoning: why this library over the alternatives.

### 2. Established Patterns

- Patterns already in use in the codebase (from scout) take precedence over external patterns.
- For patterns not yet in the codebase, cite official documentation or a canonical reference.
- Focus on patterns directly relevant to the intake goal for this stack.

### 3. Common Pitfalls

- Known footguns for the chosen libraries and patterns, sourced from official docs or `web_search`.
- File-level gotchas identified in the scout's `gotchas` list for this stack.
- Performance or correctness traps specific to this stack's integration points.

### 4. Validation and Test Architecture

- What test level is appropriate for each capability (unit, integration, e2e)?
- Which test runner and assertion approach to use (from the scout's `testPatterns`)?
- Fixture and factory requirements: what test data must be set up?
- Contract: what does "this stack's work is correct" look like as a passing test?

## Source Citation Rules

Every claim You MUST cite. Use:
- A file path for claims sourced from the repo (e.g. `src/lib/auth.ts:45`)
- A URL for claims sourced from official docs or `web_search`
- Do NOT assert best practices without a citation

## Process

### Step 1 — Load prior artifacts

Read the intake goal, scout findings for your assigned stack, and discover decisions that affect your stack.

### Step 2 — Inventory installed capabilities

Read the package manifest for your stack's directory. Note what is already present; do not propose replacing it.

### Step 3 — Fill each research area

For each gap in the existing stack, use `web_search` with specific queries (library name + version + use case). Read official docs or changelog pages. Do not use `web_search` for things already visible in the repo.

### Step 4 — Write the artifact

Call `ultraplan_research_record` exactly once:

```
ultraplan_research_record({
  stack: "frontend" | "backend" | "infrastructure",
  content: {
    libraryChoices: [
      {
        capability: string,
        chosen: string,
        version: string | null,
        reasoning: string,
        alternativesConsidered: string[],
        source: string        // file path or URL
      }
    ],
    patterns: [
      {
        name: string,
        description: string,
        source: string        // file path or URL
      }
    ],
    pitfalls: [
      {
        description: string,
        mitigation: string,
        source: string
      }
    ],
    testArchitecture: {
      unitScope: string,
      integrationScope: string,
      e2eScope: string,
      runner: string,
      fixtureApproach: string,
      source: string
    }
  }
})
```

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Cite every claim with a file path or URL | Assert best practices without evidence |
| Prefer packages already in the repo over new introductions | Propose replacing existing working libraries |
| Use `web_search` for capability gaps only | Use `web_search` for things the repo already answers |
| Call `ultraplan_research_record` exactly once | Research stacks other than your assigned stack |
| Consult discover decisions before proposing library choices | Contradict a RESOLVED discover decision |

## Final Checklist

- [ ] Every library choice cites a source
- [ ] Every pattern cites a repo file or official doc URL
- [ ] Test architecture matches the scout's observed test runner and conventions
- [ ] No library replacement proposed where an existing one works
- [ ] `ultraplan_research_record` called exactly once with `stack` matching the assigned stack
