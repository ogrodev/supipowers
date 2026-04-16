---
created: 2026-04-16
tags: [monorepo, planning, orchestration, commands]
---

# Monorepo command orchestration plan

## Goal

Make the monorepo-sensitive Supipowers commands package-aware without creating nine separate design dialects. The initiative should land as one coordinated program with a shared foundation first, then parallel command tracks that reuse the same target-resolution, path-mapping, config-layering, and state-namespacing primitives.

## Commands in scope

Core wave:
- `/supi:checks`
- `/supi:review`
- `/supi:qa`
- `/supi:generate`
- `/supi:commit`
- `/supi:fix-pr`

Supporting wave:
- `/supi:status`
- `/supi:config`
- `/supi:agents`

## Planning principles

1. Shared setup lands first.
   - Reuse the release monorepo work as the proving ground.
   - Extract generic workspace primitives out of `src/release/*` before other commands import them.

2. One target per invocation in the first monorepo wave.
   - This keeps UX and failure modes understandable.
   - Cross-package batch behavior is explicitly deferred unless a command already has a safe grouping model.

3. Root package remains first-class.
   - Monorepo support must not demote classic single-package or root-package flows.

4. Repo-wide safety can stay repo-wide.
   - Package-specific execution should not silently weaken whole-repo checks where safety matters.

5. Support commands follow core interfaces.
   - `status`, `config`, and `agents` should consume the shared monorepo layer after the core execution commands establish the required shape.

## Recommended wave model

### Wave 0 — Shared foundation

Must land first.

See: [`00-shared-foundation.md`](./00-shared-foundation.md)

### Wave 1 — Core parallel tracks

Once Wave 0 contracts are stable, these tracks can run in parallel:

- Track A: [`01-checks.md`](./01-checks.md)
- Track B: [`02-review.md`](./02-review.md)
- Track C: [`03-qa.md`](./03-qa.md)
- Track D: [`04-generate-docs.md`](./04-generate-docs.md)
- Track E: [`05-commit.md`](./05-commit.md)
- Track F: [`06-fix-pr.md`](./06-fix-pr.md)

### Wave 2 — Supporting UX and override layers

These should follow the core interface work:

- Track G: [`07-status.md`](./07-status.md)
- Track H: [`08-config.md`](./08-config.md)
- Track I: [`09-agents.md`](./09-agents.md)

## Cross-command reusable foundation

The setup step should establish these reusable structures once:

- generic `WorkspaceTarget` model
- shared workspace discovery
- shared package-manager resolution
- shared target picker and `--target` flow
- shared target lock registry
- shared path-to-package mapping
- shared package-scoped git diff/log helpers
- shared state/config path namespacing
- config layering extension for root/workspace overrides

## Parallelization boundaries

### Safe to parallelize after foundation

- `checks` and `review`
- `qa` and `generate docs`
- `commit` and `fix-pr`
- `status`, `config`, and `agents` after the config/state contracts settle

### Should remain sequential

- shared target/config/state contracts before command adoption
- support-command UX work before config merge semantics are finalized
- any migration of release internals to shared workspace modules before other commands import those modules

## Expected deliverable set

- 1 orchestration index
- 1 shared setup plan
- 9 per-command plans

## Success criteria for the overall program

- monorepo-aware commands reuse one shared workspace layer instead of re-implementing discovery and path mapping
- each command can operate on a selected package without leaking unrelated package state
- root-package behavior remains correct
- support commands expose the same package model the execution commands use
- no command has to import release-only semantics to become monorepo-aware
