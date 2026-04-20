---
name: ultraplan-remaining-slices-audit
created: 2026-04-19
status: draft
tags: [ultraplan, audit, planning, roadmap]
---

# Ultraplan Remaining Slices Audit

## Goal

Capture where the ultraplan implementation currently stands after slices 1 and 3, what remains for slices 2, 4, 5, and 6, the dependency order between those slices, and a low-effort checklist of the next phases.

## Scope

This document is an audit and sequencing guide only.

It does **not** define full implementation details for any remaining slice, and it does **not** replace the parent architecture spec at `.omp/supipowers/specs/2026-04-19-ultraplan-parent-design.md`.

## Before start any slice

Read skill://harness-engineering to have context of the mindset of a good harness, which is what we are trying to deliver.

## Current state

The codebase currently has slices 1 and 3 implemented.

Slice 1 substrate in code:

- canonical runtime contracts exist for index, manifest, authored artifacts, scenarios, proofs, blockers, stacks, domains, agent slots, cursor, and review artifacts
- repo-local ultraplan state lives under `<repo>/.omp/supipowers/ultraplans/` via `src/ultraplan/project-paths.ts`
- validated storage helpers exist for index, manifest, authored, and review artifacts
- deterministic session bucketing and cursor recompute logic exist
- presenter helpers exist for picker/status output
- `/supi:ultraplan run` and `/supi:ultraplan status` command scaffolding exist
- bare `/supi:ultraplan` and `/supi:ultraplan next` are intentionally deferred

Slice 3 substrate in code:

- shared `ultraplan` config now exists in the root Supipowers config surface
- bundled built-in agent definitions exist for all 12 reserved slots
- global custom UltraPlan agent discovery exists under `~/.omp/supipowers/ultraplan-agents/`
- deterministic slot resolution with provenance and fail-closed required-role behavior exists in `src/ultraplan/agent-catalog.ts`

## Completed substrate from slices 1 and 3

| Capability                                         | Status | Existing implementation |
| -------------------------------------------------- | ------ | ----------------------- |
| Canonical TypeBox contracts and validators         | Done   | `src/ultraplan/contracts.ts` |
| Root ultraplan path helpers                        | Done   | `src/ultraplan/project-paths.ts` |
| Validated storage layer                            | Done   | `src/ultraplan/storage.ts` |
| Deterministic session selection / cursor recompute | Done   | `src/ultraplan/session-selection.ts` |
| Picker/status presentation helpers                 | Done   | `src/ultraplan/presenter.ts` |
| `/supi:ultraplan run` / `status` command shell     | Done   | `src/commands/ultraplan.ts`, `src/bootstrap.ts` |
| Root-only ultraplan config surface                 | Done   | `src/types.ts`, `src/config/schema.ts`, `src/config/loader.ts` |
| Specialized agent catalog + built-in defaults      | Done   | `src/ultraplan/agent-catalog.ts`, `src/ultraplan/default-agents/` |
## Remaining slices

### Slice 2 — Hook tracker + recovery engine — Not started in code

Purpose:

- make runtime truth authoritative instead of model narration
- observe hook events and mutate scenario/session state only from evidence
- implement blocker classification and recovery policy

Must cover:

- `session_start`, `before_agent_start`, `tool_call`, `tool_result`, `agent_end`, `session_shutdown`
- event correlation to exactly one `(session, stack, domain, level, scenario, phase, role)` transition attempt
- proof extraction and idempotent scenario/status mutation
- deterministic auto-repair for safe cases such as stale cursor / stale derived state
- structured blockers for non-safe cases

Still missing in code:

- runtime tracker state
- correlation metadata handling
- proof parsers
- manifest mutation from hook evidence
- auto / assisted / manual recovery flow
### Slice 3 — Specialized agent catalog substrate — Implemented

Implemented in code:

- all 12 reserved role slots are represented in the built-in catalog
- root-only project `ultraplan` config supports slot mapping and per-slot `model` / `thinkingLevel` overrides
- bundled built-in definitions live under `src/ultraplan/default-agents/`
- global custom agent definitions load from `~/.omp/supipowers/ultraplan-agents/`
- precedence resolution is `project-local mapping -> global custom agent -> built-in default`
- catalog resolution substrate implements fail-closed required slots and disabled reviewers resolving to `null`, but no current runtime command path consumes the catalog yet

### Slice 4 — Authoring flow

Purpose:

- make bare `/supi:ultraplan` create a valid authored ultraplan session

Must cover:

- interactive authoring flow for the stack triad (`frontend`, `backend`, `infrastructure`)
- domain and scenario authoring with explicit `unit[]`, `integration[]`, and `e2e[]` ordering
- writing validated `authored.json`, `manifest.json`, and `index.json` entries
- user-facing review/approval before persistence

Not yet implemented:

- authoring prompt/phase sequence
- interactive authoring UX
- authored artifact creation from the command path
- review loop for authored sessions

### Slice 5 — Execution orchestration

Before start:
Read skill://mutation-testing so we can properly write tests that would kill mutants
Read .omp/researches/AutoBE/ to gather more knowledge

Purpose:

- actually run authored ultraplan work in the required order using specialized agents and hook-governed truth

Must cover:

- orchestration prompt/runtime contract
- role-based sub-agent dispatch
- TDD ownership rules across unit/integration/e2e
- domain-review and stack-review execution ordering
- blocked / awaiting-user behavior during real runs

Not yet implemented:

- orchestrator prompt
- role-based dispatch integration
- wave/batching/worktree strategy
- end-to-end run loop over authored sessions

### Slice 6 — Optional router + advanced UX

Purpose:

- improve usability after the core system is working

May cover:

- `/supi:ultraplan next`
- richer picker/status UX
- inline hints if locally feasible without upstream OMP changes

Not yet implemented:

- next-action router
- advanced picker polish
- richer status drilldowns

## Dependency order

The stable sequencing is:

1. slice 1 — data model + storage + picker/status
2. slice 2 — hook tracker + recovery engine
3. slice 3 — specialized agent catalog
4. slice 4 — authoring flow
5. slice 5 — execution orchestration
6. slice 6 — optional router + advanced UX

## Dependency notes

- Slice 2 should land before real execution, because execution needs runtime-owned proof and recovery semantics.
- Slice 3 has landed and is already available for later authoring/execution work.
- Slice 4 can be built before slice 5, but authored sessions will still stop at the existing deferred execution boundary until slices 2 and 5 exist.
- Slice 5 depends on slices 2, 3, and 4.
- Slice 6 is optional polish and should remain last.

## Phase checklist

Use this as the low-effort “what’s next” tracker:

- [x] Slice 1 — Data model + storage + picker/status
- [ ] Slice 2 — Hook tracker + recovery engine
- [x] Slice 3 — Specialized agent catalog
- [ ] Slice 4 — Authoring flow
- [ ] Slice 5 — Execution orchestration
- [ ] Slice 6 — Optional router + advanced UX
