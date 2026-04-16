---
created: 2026-04-16
tags: [monorepo, fix-pr, pull-request]
---

# `/supi:fix-pr` monorepo plan

## Goal

Make `/supi:fix-pr` process PR review comments package-by-package instead of building one giant repo-root remediation stream for the whole PR.

## Current monorepo-sensitive assumptions

Observed in:
- `src/commands/fix-pr.ts`
- `src/fix-pr/fetch-comments.ts`

Current behavior assumes:
- one PR comment stream for the whole repo
- one orchestrator run with all relevant comments
- one session namespace per repo root
- no package clustering for inline comment paths

## Design direction

### Invocation model

Use one package target per invocation in the first monorepo wave.

Behavior:
- fetch the whole PR comment stream once
- cluster comments by package using shared path mapping
- let the user pick one package cluster to process
- surface mixed/root comments separately instead of silently dropping them

### Prompt model

The orchestrator should receive only the selected package’s comments and only the file paths relevant to that package.

### Session model

Fix-PR sessions should be namespaced by PR and package target so reruns for different packages do not collide.

## Dependencies on shared foundation

Required before implementation:
- shared `WorkspaceTarget`
- target picker / `--target` helper
- path-to-package mapping for review comment file paths
- package-scoped session path builder

## Suggested parallel workstreams

### Agent A — Package clustering and command flow

Files:
- `src/commands/fix-pr.ts`
- `src/fix-pr/fetch-comments.ts`
- fix-pr command tests

Scope:
- group fetched comments by package
- add target selection / `--target`
- isolate the selected package’s comment stream

### Agent B — Prompt and remediation session scoping

Files:
- `src/fix-pr/prompt-builder.ts`
- `src/storage/fix-pr-sessions.ts`
- fix-pr storage tests

Scope:
- include package context in remediation prompts
- namespace sessions by PR + package

### Agent C — Mixed/root comment handling

Files:
- `src/commands/fix-pr.ts`
- tests for clustering behavior

Scope:
- surface comments that do not belong cleanly to one package
- keep root-level comments actionable without polluting package-targeted runs

## Acceptance criteria

- `/supi:fix-pr --target <package>` processes only comments belonging to the selected package
- package-targeted sessions do not overwrite each other
- comments from unrelated packages are excluded from the selected run
- root or mixed-scope comments are surfaced explicitly
- current single-package PR flow remains intact

## Risks

- comment ownership is less clean than file ownership when reviewers comment on shared root files
- fetching once and clustering later is correct, but the UX must make it obvious that not every PR comment is in the selected package batch
- root-level comments may need their own follow-up mode after the first wave

## Explicit non-goals for this wave

- simultaneous multi-package fix-pr runs from one invocation
- automatic repartitioning of one package run into many package sub-runs
- redesigning the broader PR comment assessment workflow
