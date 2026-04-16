---
created: 2026-04-16
tags: [monorepo, status, support]
---

# `/supi:status` monorepo plan

## Goal

Make `/supi:status` capable of showing workspace-aware project state instead of a single flat project summary.

## Wave placement

Support wave. This should follow the shared foundation and the first round of core command work because it consumes the workspace/config/state model rather than defining it.

## Current monorepo-sensitive assumptions

Observed in:
- `src/commands/status.ts`
- `src/config/loader.ts`

Current behavior assumes:
- one effective config for one project root
- one plans directory and one summary view
- one gate summary with no package dimension

## Design direction

### Default view

Provide an aggregate overview across packages with clear package labels.

### Optional view

Add a scoped package view once target selection helpers already exist.

The command should not invent a separate workspace model. It should consume the shared target discovery and shared config/state paths.

## Dependencies on shared foundation

Required before implementation:
- shared `WorkspaceTarget`
- config layering extension
- package-scoped state/path convention

## Suggested workstreams

### Agent A — Aggregate status model

Files:
- `src/commands/status.ts`
- status tests

Scope:
- summarize packages, plans, and config state by package
- preserve a readable single-package summary

### Agent B — Config/state integration

Files:
- `src/config/loader.ts`
- plan/status storage helpers

Scope:
- surface root/workspace config state and errors clearly
- consume package-scoped plans/reports if those paths exist

## Acceptance criteria

- status can show package-aware summaries in a monorepo
- root/single-package repos still produce a compact summary
- config errors and plan/report counts can be associated with the correct package or root scope

## Risks

- aggregate status can become noisy in large monorepos unless package labels and ordering are clear
- status should not race ahead of the actual package-scoped storage contracts used by the core commands

## Explicit non-goals for this wave

- full monorepo dashboards beyond the command UI
- implementing config-layering semantics inside status itself
