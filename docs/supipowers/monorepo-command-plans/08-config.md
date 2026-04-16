---
created: 2026-04-16
tags: [monorepo, config, support]
---

# `/supi:config` monorepo plan

## Goal

Make `/supi:config` understand root and workspace config scopes so users can inspect and edit the same layering model that monorepo-aware commands consume.

## Why this is partly support work

The config loader semantics should land in the shared foundation because core commands need them. The command UI, however, should follow the foundation so it can present the final root/workspace model instead of guessing ahead of it.

## Current monorepo-sensitive assumptions

Observed in:
- `src/commands/config.ts`
- `src/config/loader.ts`

Current behavior assumes:
- defaults → global → project layering only
- one project config path derived from `ctx.cwd`
- no scope selector in the UI
- all writes target one project-level config file

## Design direction

### Scope model

After foundation, config should support:
- global
- root
- workspace

### UI model

Add an explicit scope selector before editing settings.

The UI should also show inheritance clearly:
- inherited value
- overridden value
- where the value is stored

### Write model

`/supi:config` should write to the selected scope, not to an implicit project file.

## Dependencies on shared foundation

Required before implementation:
- config layering extension in loader
- scope-aware path resolution
- workspace discovery / target selection helpers

## Suggested workstreams

### Agent A — Loader and types contract stabilization

Files:
- `src/config/loader.ts`
- `src/types.ts`
- config tests

Scope:
- finalize root/workspace merge semantics
- finalize config scope naming

### Agent B — Config UI scope selector

Files:
- `src/commands/config.ts`
- config command tests

Scope:
- add scope selection
- show inheritance and override location
- write changes to the chosen scope

## Acceptance criteria

- config loader can resolve defaults → global → root → workspace
- `/supi:config` can inspect and edit the selected scope explicitly
- inherited vs overridden values are visible in the UI
- single-package repos keep a simple experience

## Risks

- ambiguous naming around “project”, “root”, and “workspace” will confuse users unless standardized first
- if the UI lands before the loader contract is stable, it will need rework
- commands must all interpret the same layering order or the config UI will lie

## Explicit non-goals for this wave

- inventing package-specific config semantics outside the shared loader contract
- command-specific settings redesign beyond scope awareness
