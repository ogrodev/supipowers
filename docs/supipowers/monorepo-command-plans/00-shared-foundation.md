---
created: 2026-04-16
tags: [monorepo, setup, foundation, shared-infrastructure]
---

# Shared monorepo foundation

## Goal

Establish the reusable workspace layer that every monorepo-sensitive command can adopt without depending on release-specific semantics.

## Why this lands first

The current release work already proves the value of package-aware target selection, package-manager resolution, target locking, and target-scoped execution. Other commands need those same primitives, but they should not import `ReleaseTarget` or `src/release/*` and inherit tag/changelog/publish semantics they do not need.

## Required outputs

1. A generic `WorkspaceTarget` model.
2. Shared workspace discovery and package-manager resolution modules.
3. Shared target selection and lock utilities.
4. Shared path-to-package mapping and package-scoped git helpers.
5. Shared state/config path namespacing.
6. Config layering support for root and workspace overrides.
7. Release migrated to the shared modules as the proving-ground consumer.

## Proposed shared abstractions

### 1. Workspace model

Create a package-agnostic target model with fields like:
- `id`
- `name`
- `kind`
- `repoRoot`
- `packageDir`
- `manifestPath`
- `relativeDir`
- `version`
- `private`
- `packageManager`

`ReleaseTarget` should become a release-specific extension of this type rather than the canonical cross-command model.

### 2. Workspace discovery and package manager

Move the reusable parts of:
- `src/release/targets.ts`
- `src/release/package-manager.ts`

into a shared workspace namespace.

Keep release-only logic in release:
- publish scope derivation
- default tag format
- release tag semantics

### 3. Target selection and locks

Generalize the release target picker/`--target` flow into shared command helpers.

Also move the current in-memory same-target lock into a reusable registry keyed by:
- command name
- target id

This lets multiple commands coordinate without copy-pasting module-local `Set<string>` patterns.

### 4. Path mapping and git helpers

Create shared helpers for:
- mapping repo-relative file paths to owning packages
- partitioning changed files by package
- filtering git diff/log output to a selected package
- ranking changed targets before unchanged targets

These are required by `checks`, `review`, `generate docs`, `commit`, and `fix-pr`.

### 5. State and config namespacing

Introduce one shared convention for per-package state paths under `.omp/supipowers/`.

Examples:
- per-package QA config/session storage
- per-package doc drift state
- per-package review sessions or reports
- per-package fix-pr sessions

### 6. Config layering extension

Extend config semantics from:
- defaults → global → project

to:
- defaults → global → root → workspace

This must be done once in the loader layer and then consumed by commands. The config command UI can follow later, but the loader contract belongs here because core commands need it.

## Recommended implementation tracks

### Track A — Workspace contracts

Suggested files:
- `src/types.ts`
- `src/workspace/targets.ts` or equivalent
- `src/workspace/package-manager.ts`
- `tests/release/targets.test.ts`
- `tests/release/package-manager.test.ts`

Deliverables:
- generic target type
- shared discovery API
- shared package-manager API

### Track B — Shared command utilities

Suggested files:
- `src/workspace/selector.ts`
- `src/workspace/locks.ts`
- `src/workspace/path-mapping.ts`
- `src/workspace/git-scope.ts`
- new tests under `tests/workspace/`

Deliverables:
- target picker helper
- target lock registry
- changed-file/package partition helpers
- git path-filter helpers

### Track C — Config and state namespace layer

Suggested files:
- `src/config/loader.ts`
- `src/platform/types.ts`
- `src/types.ts`
- `src/storage/*` helpers as needed
- config/storage tests

Deliverables:
- root/workspace config merge contract
- shared package-scoped state-path convention

### Track D — Proving-ground migration

Suggested files:
- `src/commands/release.ts`
- `src/release/targets.ts`
- `src/release/package-manager.ts`
- `src/release/executor.ts`
- release tests

Deliverables:
- release imports shared modules cleanly
- no regression in current monorepo release support

## Acceptance criteria

- no non-release command needs to import release-only types to become package-aware
- shared workspace modules exist and release consumes them
- target locking and target selection are reusable helpers, not release-local logic
- shared path-to-package and git-scope helpers exist with tests
- config loader can represent root/workspace layering, even if UI consumers land later
- release regression tests still pass after extraction

## Risks

- extracting too little leaves every command coupled to release internals
- extracting too much pulls release-only semantics into generic modules
- changing config layering without a stable storage convention will force rework in `qa`, `generate`, `review`, and `fix-pr`

## Out of scope

- command-specific behavior changes outside release proving-ground migration
- support-command UX for choosing config scope
- cross-package batch workflows
