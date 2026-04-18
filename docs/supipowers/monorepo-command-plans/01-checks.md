---
created: 2026-04-16
updated: 2026-04-17
tags: [monorepo, checks, quality-gates]
---

# `/supi:checks` monorepo plan

## Status

The original one-target-per-invocation plan is superseded.

`/supi:checks` now follows the accepted monorepo UX:
- default to `All` in monorepos
- `All` means root target plus every workspace target
- run those targets sequentially
- keep per-target report storage
- load general Supipowers config from global + repository scopes only

## Current design

### Target model

- Single-package repo: run the root target with no extra ceremony.
- Monorepo: show `All` first in the picker and make it the default selection.
- `--target <package>` still narrows execution to one target.
- `--target all` explicitly requests batch mode for non-interactive runs.

### Execution model

- Resolve workspace targets from the repo root.
- Reuse the existing per-target quality runner.
- Run `All` sequentially: root target first, then each workspace target.
- Save one report per target in the existing target-scoped state directory.
- Finish with one aggregated summary that lists per-target status and report paths.

### Config model

`/supi:checks` no longer consumes workspace-level general config overrides.

Only these scopes apply:
1. built-in defaults
2. `~/.omp/supipowers/config.json`
3. `<repo>/.omp/supipowers/config.json`

## What changed from the original plan

The earlier draft assumed:
- one target per invocation
- changed-target auto-selection instead of batch default
- optional workspace config consumption

Those assumptions are no longer accurate.

## Acceptance criteria

- `/supi:checks` defaults to `All` in monorepos.
- `All` runs the root target and every workspace target.
- `--target <package>` still works for single-target runs.
- `--target all` works without the picker.
- Reports remain target-scoped.
- Repository config is shared across every monorepo target.
