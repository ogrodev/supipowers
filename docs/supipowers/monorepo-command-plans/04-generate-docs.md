---
created: 2026-04-16
tags: [monorepo, docs, generate, drift]
---

# `/supi:generate` docs monorepo plan

## Goal

Make the docs drift workflow package-aware so it can track and regenerate docs for a selected package without mixing repo-wide docs and unrelated package docs.

## Current monorepo-sensitive assumptions

Observed in:
- `src/commands/generate.ts`
- `src/docs/drift.ts`

Current behavior assumes:
- one `git ls-files` document universe per cwd
- one `doc-drift.json` state file per project root
- one tracked-doc set for the whole repo
- no distinction between root docs and package-local docs

## Design direction

### Invocation model

Use one target per invocation, with explicit support for the root package/docs target.

Behavior:
- `--target <package>` selects a package-local docs scope
- root selection keeps repo-wide or root-doc behavior
- interactive selection ranks changed packages first

### Scope model

Doc discovery and doc drift comparison should be filtered to the selected target.

Rules:
- package target: only package-local docs and files relevant to that package
- root target: root docs and repo-wide docs

### State model

Doc drift state should be namespaced per target so tracked docs for package A do not overwrite tracked docs for package B.

## Dependencies on shared foundation

Required before implementation:
- shared `WorkspaceTarget`
- target picker / `--target` helper
- package-scoped git file filtering
- package-scoped state path builder
- package manifest helper for root-vs-package doc scope decisions

## Suggested parallel workstreams

### Agent A — Command flow and target selection

Files:
- `src/commands/generate.ts`
- generate command tests

Scope:
- add target selection
- thread selected target into drift loading/saving and generation prompts

### Agent B — Drift discovery and filtering

Files:
- `src/docs/drift.ts`
- docs drift tests

Scope:
- filter `git ls-files` and other discovery to the selected target
- distinguish root docs from package docs

### Agent C — State namespacing and UX clarity

Files:
- `src/docs/drift.ts`
- storage helpers if introduced
- tests around state load/save

Scope:
- namespace doc drift state by target
- show selected target clearly in drift summaries

## Acceptance criteria

- `/supi:generate --target <package>` evaluates docs for only the selected package
- package-local tracked-doc state is isolated from root and sibling packages
- root docs mode still works cleanly
- unchanged single-package repos behave as they do today

## Risks

- doc ownership can be ambiguous when root docs describe multiple packages; the first wave should prefer explicit target scoping over aggressive auto-inference
- package-local docs may still depend on shared root docs; that relationship should be surfaced, not silently flattened
- tracked-doc migration from one repo-wide state file to many package-scoped files needs a clear transition path in implementation

## Explicit non-goals for this wave

- simultaneous multi-package doc regeneration
- full doc ownership inference across every shared root document
- redesigning the broader docs generation UX beyond target scoping
