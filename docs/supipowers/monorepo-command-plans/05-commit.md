---
created: 2026-04-16
tags: [monorepo, commit, git]
---

# `/supi:commit` monorepo plan

## Goal

Make `/supi:commit` package-aware so it stops staging and analyzing the entire repo by default in monorepos, while preserving the existing multi-commit execution engine.

## Current monorepo-sensitive assumptions

Observed in:
- `src/commands/commit.ts`
- `src/git/commit.ts`

Current behavior assumes:
- `git add -A` stages the whole repo
- the AI prompt sees one repo-wide diff and file list
- diff byte budgets are applied to the whole repo payload
- commit scope is AI-inferred rather than structurally package-derived

## Design direction

### Invocation model

Use one selected target per invocation in the first monorepo wave.

Behavior:
- if nothing is staged, let the user pick a package target and stage that package only
- if exactly one package is staged, continue normally with package-aware context
- if multiple packages are staged, fail fast with guidance instead of silently mixing them in the first wave

### Scope model

The AI analysis prompt should receive a package-scoped diff, package identity, and a derived conventional-commit scope hint.

### Execution model

Keep the current index-based commit execution engine. The risk is in upstream staging and planning, not in the downstream `write-tree` / `read-tree` mechanics.

## Dependencies on shared foundation

Required before implementation:
- shared `WorkspaceTarget`
- target picker / `--target` helper
- path-to-package mapping
- package-derived commit scope helper
- package-scoped state/progress naming if needed

## Suggested parallel workstreams

### Agent A — Command flow and package-aware staging

Files:
- `src/commands/commit.ts`
- `src/git/commit.ts`
- commit command tests

Scope:
- add target selection when staging is needed
- replace repo-wide staging with package-aware staging for monorepo flow
- detect and reject multi-package staged input in the first wave

### Agent B — Diff partitioning and prompt shaping

Files:
- `src/git/commit.ts`
- git commit tests

Scope:
- ensure prompt input is package-scoped
- derive commit scope from package name/path
- keep byte budgets meaningful at package scope

### Agent C — Regression coverage and UX polish

Files:
- commit tests under `tests/git/` and `tests/commands/`

Scope:
- add monorepo-targeted commit coverage
- preserve current single-package behavior

## Acceptance criteria

- monorepo commit flow no longer stages the entire repo by default
- `/supi:commit` can operate on one selected package target at a time
- AI prompt/diff input is package-scoped
- commit scope can be derived from the selected package where appropriate
- classic single-package behavior remains intact

## Risks

- changing staging semantics changes user expectations; this must be explicit in the UI
- rejecting multi-package staged changes is intentionally conservative but may frustrate users until a later batch mode exists
- package-scoped diff budgeting must still preserve enough context for coherent commit planning

## Explicit non-goals for this wave

- automatic multi-package split commits from one invocation
- repo-wide batch commit orchestration
- per-package commit convention UIs
