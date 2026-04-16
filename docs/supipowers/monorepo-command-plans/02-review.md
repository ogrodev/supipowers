---
created: 2026-04-16
tags: [monorepo, review, ai-review]
---

# `/supi:review` monorepo plan

## Goal

Make `/supi:review` operate on a selected package target so that diff scope, review execution, validation, and session persistence stop mixing unrelated packages from the same monorepo.

## Current monorepo-sensitive assumptions

Observed in:
- `src/commands/ai-review.ts`
- `src/review/scope.ts`

Current behavior assumes:
- one repo-root `ctx.cwd`
- PR/uncommitted/commit scope built at repo root
- one flat file list and diff payload
- one config/model resolution root
- one review session/report namespace

## Design direction

### Invocation model

First monorepo wave should use one target per invocation.

Behavior:
- accept `--target <package>`
- otherwise show a target picker with changed packages first
- preserve root-package review as a first-class path

### Scope model

All scope builders in `src/review/scope.ts` should become target-aware.

This includes:
- PR scope
- uncommitted scope
- commit scope
- custom instructions that reference a selected package context

The selected target should filter both file lists and diff text before they reach the AI review pipeline.

### Persistence model

Review sessions and artifacts should be namespaced per package target so that a review for `packages/a` does not collide with a review for `packages/b` in the same repo.

## Dependencies on shared foundation

Required before implementation:
- shared `WorkspaceTarget`
- target picker / `--target` helper
- changed-file-to-package mapping
- package-scoped git diff helpers
- package-scoped state/session path builder
- config/model resolution contract for root/workspace overrides if introduced in the first wave

## Suggested parallel workstreams

### Agent A — Review command flow and target selection

Files:
- `src/commands/ai-review.ts`
- `src/types.ts`
- `tests/commands/ai-review.test.ts`

Scope:
- add target selection to command entry
- thread selected target into scope and session creation
- preserve existing review-level UX

### Agent B — Scope builders and diff filtering

Files:
- `src/review/scope.ts`
- related review scope tests

Scope:
- make PR/uncommitted/commit scope builders target-aware
- filter diff/file lists to the selected package
- keep root-package behavior correct

### Agent C — Session and artifact namespacing

Files:
- `src/storage/review-sessions.ts`
- `src/review/*` persistence consumers
- review session tests

Scope:
- namespace sessions and artifacts by package target
- surface package context in summaries and stored reports

## Acceptance criteria

- `/supi:review --target <package>` reviews only the selected package
- PR/uncommitted/commit scopes exclude unrelated package files
- interactive target selection ranks changed packages first
- persisted review sessions and artifacts are package-scoped
- root/single-package review still works unchanged for classic repos

## Risks

- review scope and review persistence can drift if only one becomes target-aware
- very large monorepo PRs still need careful diff budgeting even after package filtering
- custom instructions may accidentally imply repo-wide context unless the selected target is surfaced clearly in the prompt/session metadata

## Explicit non-goals for this wave

- multi-package batch review in one invocation
- workspace-specific review-agent overrides in the first core wave
- aggregate dashboards across many package review sessions
