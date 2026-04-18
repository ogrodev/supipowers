---
created: 2026-04-16
updated: 2026-04-17
tags: [monorepo, config, support]
---

# `/supi:config` monorepo plan

## Status

The original root/workspace scope plan is superseded.

`/supi:config` now follows the accepted shared-config model:
- only `Global` and `Repository` are user-facing scopes
- monorepos use one shared repository config file
- there are no per-workspace Supipowers config overrides for general settings

## Current design

### Scope model

General Supipowers config uses one repository file per checkout:
1. built-in defaults
2. `~/.omp/supipowers/config.json`
3. `<repo>/.omp/supipowers/config.json`

That same model applies to both single-package repos and monorepos.

### UI model

- Single-package repo: default to `Repository`.
- Monorepo: still default to `Repository`.
- Monorepo copy should make it clear that repository scope is shared across every workspace.
- Provenance strings are limited to:
  - `default`
  - `overridden in global`
  - `inherited from global`
  - `overridden in repository`

### Write model

`/supi:config` always writes general settings to either:
- `~/.omp/supipowers/config.json`, or
- `<repo>/.omp/supipowers/config.json`

It does not write `.omp/supipowers/workspaces/<workspace>/config.json` for general Supipowers settings.

## What changed from the original plan

The earlier draft assumed:
- root + workspace scope selection in the UI
- workspace inheritance display
- workspace config writes

Those assumptions are no longer accurate.

## Acceptance criteria

- `/supi:config` exposes only `Global` and `Repository`.
- Running from inside a workspace package still edits the shared repository config.
- Monorepos do not rely on hidden workspace-level general config files.
- Single-package repository behavior stays simple.
