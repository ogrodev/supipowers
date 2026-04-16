---
created: 2026-04-16
tags: [monorepo, agents, support]
---

# `/supi:agents` monorepo plan

## Goal

Make `/supi:agents` workspace-aware if review-agent overrides become package-specific, while preserving the current global/project shadowing behavior as the base merge pattern.

## Why this is a support-wave command

`/supi:agents` should follow the workspace-aware review configuration model rather than invent it. The merge semantics belong in agent loading and config resolution first; the command UI should present that final shape.

## Current monorepo-sensitive assumptions

Observed in:
- `src/commands/agents.ts`
- `src/review/agent-loader.ts`

Current behavior assumes:
- two scopes only: global and project
- project scope shadows global by agent name
- project `enabled: false` suppresses the global agent of the same name
- command UI shows one merged project-wide result

## Design direction

### Merge model

Extend the current merge semantics from:
- global → project

to:
- global → root → workspace

Preserve the same shadowing and suppression rules so the mental model stays consistent.

### UI model

The command should show each agent’s source scope explicitly:
- global
- root
- workspace

Users should be able to tell whether an agent is inherited, overridden, or disabled in the current workspace.

## Dependencies on shared foundation

Required before implementation:
- workspace resolution primitive
- config/path layering for root/workspace review-agent storage
- stable review command package model if workspace-specific review agents are included in the first support wave

## Suggested workstreams

### Agent A — Loader merge extension

Files:
- `src/review/agent-loader.ts`
- agent loader tests

Scope:
- extend merge order to global → root → workspace
- preserve existing shadowing/disable semantics

### Agent B — Command UI provenance

Files:
- `src/commands/agents.ts`
- agents command tests

Scope:
- show source scope in the UI
- make workspace context explicit when listing the effective agent set

## Acceptance criteria

- effective review-agent loading can represent root and workspace overrides
- `/supi:agents` shows where each effective agent definition came from
- disable/shadow semantics remain consistent with today’s project-over-global behavior
- single-package repos keep the existing mental model

## Risks

- adding scopes without surfacing provenance will make the merged set much harder to understand
- review-agent storage location choices should align with the broader config/state namespace strategy
- if review itself stays project-wide while agents become workspace-aware, the UX will be inconsistent

## Explicit non-goals for this wave

- redesigning the whole agents UI beyond scope awareness
- per-package agent authoring workflows that bypass the shared storage conventions
