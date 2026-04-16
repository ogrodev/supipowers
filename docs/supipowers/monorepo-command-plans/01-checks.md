---
created: 2026-04-16
tags: [monorepo, checks, quality-gates]
---

# `/supi:checks` monorepo plan

## Goal

Make `/supi:checks` operate on a selected package target instead of assuming one repo-wide cwd for scope discovery, gate execution, config lookup, and report persistence.

## Current monorepo-sensitive assumptions

Observed in:
- `src/commands/review.ts`
- `src/quality/runner.ts`

Current behavior assumes:
- one `ctx.cwd`
- one flat changed-file list
- one flat all-files fallback via `git ls-files`
- one effective config
- one report output path

## Design direction

### Invocation model

First monorepo wave should use one target per invocation.

Behavior:
- auto-select the only publishable/owned target when obvious
- accept `--target <package>`
- otherwise show a target picker with changed packages first

### Scope model

`discoverReviewScope` should stop returning one flat repo-wide scope. It should either:
- accept a selected `WorkspaceTarget`, or
- receive a package filter derived from shared path mapping

### Execution model

Gate execution should run with the selected package root as the execution context while keeping repo-root git access where needed for changed-file discovery.

### Reporting model

Reports should be package-scoped by default, with the option to add an aggregate summary later.

## Dependencies on shared foundation

Required before implementation:
- shared `WorkspaceTarget`
- target picker / `--target` helper
- changed-file-to-package mapping
- package-scoped git diff/file discovery helpers
- config layering extension if workspace overrides are supported in the first wave
- package-scoped state/report path builder

## Suggested parallel workstreams

### Agent A — Command flow and target selection

Files:
- `src/commands/review.ts`
- `src/types.ts`
- `tests/commands/review.test.ts`

Scope:
- add target resolution
- add `--target`
- thread selected target into quality runner

### Agent B — Runner scope and gate context

Files:
- `src/quality/runner.ts`
- gate-related tests under `tests/quality/`

Scope:
- partition scope by package
- run gates against selected target root
- preserve per-gate parallelism

### Agent C — Reporting and workspace config consumption

Files:
- `src/commands/review.ts`
- `src/config/loader.ts`
- storage/report tests

Scope:
- package-scoped report output
- package label in summaries and fix prompts
- workspace override consumption if foundation exposes it

## Acceptance criteria

- `/supi:checks --target <package>` runs only against the selected package
- interactive selection ranks changed packages first
- changed-file and all-files discovery exclude unrelated packages for package-targeted runs
- gate commands execute in the selected package root
- reports clearly identify the package they belong to
- root/single-package behavior still works without monorepo-specific ceremony

## Risks

- the local `ReviewScope` shape in `src/quality/runner.ts` diverges from the review pipeline’s scope type and could fork further if changed carelessly
- per-package config overrides can create surprising differences between packages unless surfaced clearly in output
- aggregate reporting should not block first-wave package-scoped correctness

## Explicit non-goals for this wave

- multi-package batch checks in one invocation
- cross-package aggregate dashboards beyond a simple follow-up summary
- command-specific config UI changes
