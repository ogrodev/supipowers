---
name: ultraplan-remaining-slices-audit
created: 2026-04-19
updated: 2026-04-21
status: draft
tags: [ultraplan, audit, planning, roadmap]
---

# Ultraplan Remaining Slices Audit

## Goal

Capture where the ultraplan implementation currently stands after slices 1, 2, 3, and 4, what remains for slices 5 and 6, the dependency order between those slices, and a low-effort checklist of the next phases.

## Scope

This document is an audit and sequencing guide only.

It does **not** define full implementation details for any remaining slice, and it does **not** replace the parent architecture spec at `.omp/supipowers/specs/2026-04-19-ultraplan-parent-design.md`.

## Before start any slice

Read skill://harness-engineering to have context of the mindset of a good harness, which is what we are trying to deliver.

## Current state

The codebase currently has slices 1, 2, 3, and 4 implemented.

Slice 1 substrate in code:

- canonical runtime contracts exist for index, manifest, authored artifacts, scenarios, proofs, blockers, stacks, domains, agent slots, cursor, and review artifacts
- repo-local ultraplan state lives under `<repo>/.omp/supipowers/ultraplans/` via `src/ultraplan/project-paths.ts`
- validated storage helpers exist for index, manifest, authored, and review artifacts
- deterministic session bucketing and cursor recompute logic exist
- presenter helpers exist for picker/status output
- `/supi:ultraplan run` and `/supi:ultraplan status` command scaffolding exist
- bare `/supi:ultraplan next` is still intentionally deferred to a later phase

Slice 3 substrate in code:

- shared `ultraplan` config now exists in the root Supipowers config surface
- bundled built-in agent definitions exist for all 12 reserved slots
- global custom UltraPlan agent discovery exists under `~/.omp/supipowers/ultraplan-agents/`
- deterministic slot resolution with provenance and fail-closed required-role behavior exists in `src/ultraplan/agent-catalog.ts`
- global stub files that omit meaningful ultraplan policy are tolerated rather than rejected during config load (`src/config/loader.ts`)

Slice 4 substrate in code:

- bare `/supi:ultraplan` now launches a deterministic in-extension authoring wizard (no LLM in the loop) that produces a schema-valid `{authored.json, manifest.json, index.json}` triad gated by explicit user approval
- pure draft ops live in `src/ultraplan/authoring-draft.ts` (applicability, domain, scenario, projections, readiness gate)
- single persistence boundary in `src/ultraplan/authoring-persist.ts` owns `loadUltraPlanIndex`, debris/collision detection, atomic `authored.json → manifest.json → index.json` write, and reverse-order rollback
- wizard in `src/ultraplan/authoring-wizard.ts` orchestrates preflight, title/goal, per-stack applicability, per-stack domain loop, per-domain scenario loop, review, and persist with typed cancellation semantics
- `renderUltraPlanAuthoredDraft` in `src/ultraplan/presenter.ts` drives the review screen with deterministic output and readiness-blocker annotations
- approved sessions round-trip through `loadUltraPlanIndex` / `loadUltraPlanSessionSummary` / `getVisibleUltraPlanSessions` / `resolveUltraPlanCurrentCursor` and appear in `/supi:ultraplan run` and `/supi:ultraplan status` with `state: "ready"` and a red/planned cursor

## Completed substrate from slices 1, 2, 3, and 4

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
| Authoring wizard (draft + persist + review)        | Done   | `src/ultraplan/authoring-draft.ts`, `src/ultraplan/authoring-persist.ts`, `src/ultraplan/authoring-wizard.ts`, `src/ultraplan/presenter.ts` |

## Slice-by-slice status

### Slice 2 — Hook tracker + recovery engine — Implemented

Implemented in code:

- runtime tracker, migration record, hooks log, and pending-mutation storage seams exist in `src/ultraplan/runtime/tracker-storage.ts`
- structured runtime blocker factories exist in `src/ultraplan/runtime/blockers.ts`
- migration engine exists in `src/ultraplan/runtime/migration.ts` and fails closed with `migration-unsafe` / `migration-conflict` blockers
- hook bridge in `src/ultraplan/runtime/hook-bridge.ts` wires `session_start`, `before_agent_start`, `tool_call`, `tool_result`, `agent_end`, and `session_shutdown` into the runtime pipeline
- pure reducer in `src/ultraplan/runtime/reducer.ts` owns replay dedupe, legal transition handling, proof/blocker precedence, and interrupted-attempt classification
- deterministic repair engine in `src/ultraplan/runtime/repair.ts` covers safe auto-repair cases and emits `unsafe-repair-required` when deterministic recovery would lie about runtime truth

Current boundary: Slice 2 runtime substrate exists, but real execution wiring still lands in Slice 5.

### Slice 3 — Specialized agent catalog substrate — Implemented

Implemented in code:
- all 12 reserved role slots are represented in the built-in catalog
- root-only project `ultraplan` config supports slot mapping and per-slot `model` / `thinkingLevel` overrides
- bundled built-in definitions live under `src/ultraplan/default-agents/`
- global custom agent definitions load from `~/.omp/supipowers/ultraplan-agents/`
- precedence resolution is `project-local mapping -> global custom agent -> built-in default`
- empty or policy-less global ultraplan stubs are stripped before merge/validation, so a bare `~/.omp/supipowers/config.json` no longer breaks catalog resolution
- catalog resolution substrate implements fail-closed required slots and disabled reviewers resolving to `null`; Slice 4 authoring now consumes the resolved bindings and Slice 5 will extend that into real execution

### Slice 4 — Authoring flow — Implemented

Implemented in code:

- bare `/supi:ultraplan` now launches a deterministic in-extension authoring wizard (no LLM in the loop) via `src/commands/ultraplan.ts` → `src/ultraplan/authoring-wizard.ts`
- pure draft ops live in `src/ultraplan/authoring-draft.ts` (applicability, domain, scenario, projections, readiness gate)
- single persistence boundary in `src/ultraplan/authoring-persist.ts` owns `loadUltraPlanIndex`, debris/collision detection, atomic `authored.json → manifest.json → index.json` write, and reverse-order rollback
- interactive authoring covers the stack triad, per-stack applicability, per-stack domain loop, per-domain scenario loop for `unit[]` / `integration[]` / `e2e[]`, a review screen rendered by `renderUltraPlanAuthoredDraft`, and an explicit approve/discard gate
- authored artifacts are schema-valid against the Slice-1 contracts and immediately pick up through `/supi:ultraplan run` and `/supi:ultraplan status`
- seeded catalog from Slice 3 feeds `stack.agentSlots` at draft construction; reviewer bindings only materialize when the corresponding review gate is enabled

### Slice 5 — Execution orchestration

Implemented scope:

- `/supi:ultraplan run` now executes one selected authored session in strict order instead of stopping at inspect-only status
- reserved-slot dispatch is wired through the new execution layer (`src/ultraplan/execution/*`) and runtime-owned truth remains in the hook/reducer/apply pipeline
- runtime-owned pause/completion behavior is deterministic: blocked and awaiting-user sessions stop before dispatch; completed sessions short-circuit cleanly
- manifest/authored/tracker mutation durability now flows through `src/ultraplan/runtime/apply-mutation.ts` with pending-mutation staging, canonical review-reference validation, and replay-safe logs
- active-execution fallback, target-hint carriers, `ultraplan_signal`, nested-dispatch blocking, and repair-time pending-mutation reconciliation are all in place

Delivered constraints:

- single-session orchestration only
- no batching, waves, or worktree fan-out
- no `/supi:ultraplan next` router yet

### Slice 6 — Optional router + advanced UX

Purpose:

- improve usability after the core single-session execution path is working

May cover:

- `/supi:ultraplan next`
- richer picker/status UX
- inline hints if locally feasible without upstream OMP changes

Not yet implemented:

- next-action router
- advanced picker polish
- richer status drilldowns

### Slice 7 — Batched execution + worktree orchestration

Deferred follow-up:

- wave planning across multiple authored sessions
- batching / fan-out scheduling
- dedicated worktree orchestration for parallel or isolated execution
- any execution model that goes beyond the Slice 5 single-session run loop

## Dependency order

The stable sequencing is:

1. slice 1 — data model + storage + picker/status
2. slice 2 — hook tracker + recovery engine
3. slice 3 — specialized agent catalog
4. slice 4 — authoring flow
5. slice 5 — single-session execution orchestration
6. slice 6 — optional router + advanced UX
7. slice 7 — batched execution + worktree orchestration

## Dependency notes

- Slice 2 should land before real execution, because execution needs runtime-owned proof and recovery semantics.
- Slice 3 has landed and is already available for later authoring/execution work.
- Slice 4 has landed. Authored sessions now exist and are picked up by `/supi:ultraplan run` and `/supi:ultraplan status`.
- Slice 5 has landed for strict single-session orchestration; batching and worktree fan-out remain explicitly deferred to Slice 7.
- Slice 6 is optional polish and should remain after the core single-session execution path.
- Slice 7 is intentionally last because it builds on the Slice 5 runtime truth model instead of inventing a parallel executor.

## Phase checklist

Use this as the low-effort “what’s next” tracker:

- [x] Slice 1 — Data model + storage + picker/status
- [x] Slice 2 — Hook tracker + recovery engine (plan: `.omp/supipowers/plans/2026-04-20-ultraplan-slice-2.md`; specs: `.omp/supipowers/specs/2026-04-19-ultraplan-slice-2-runtime-design.md` + `.omp/supipowers/specs/2026-04-20-ultraplan-slice-2-storage-and-migration-delta.md`)
- [x] Slice 3 — Specialized agent catalog
- [x] Slice 4 — Authoring flow (plan: `.omp/supipowers/plans/2026-04-21-ultraplan-slice-4.md`; spec: `.omp/supipowers/specs/2026-04-21-ultraplan-slice-4-authoring-flow-design.md`)
- [x] Slice 5 — Execution orchestration (single-session run loop)
- [ ] Slice 6 — Optional router + advanced UX
- [ ] Slice 7 — Batched execution + worktree orchestration