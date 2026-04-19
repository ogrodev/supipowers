# GSD Workflow Research

This folder stores a split, repo-grounded reference for how GSD (`gsd-build/get-shit-done`) works end-to-end.

## Primary sources inspected

Docs:
- `README.md`
- `docs/USER-GUIDE.md`
- `docs/COMMANDS.md`
- `docs/ARCHITECTURE.md`

Workflow definitions:
- `get-shit-done/workflows/new-project.md`
- `get-shit-done/workflows/map-codebase.md`
- `get-shit-done/workflows/discuss-phase.md`
- `get-shit-done/workflows/ui-phase.md`
- `get-shit-done/workflows/plan-phase.md`
- `get-shit-done/workflows/execute-phase.md`
- `get-shit-done/workflows/execute-plan.md`
- `get-shit-done/workflows/verify-work.md`
- `get-shit-done/workflows/next.md`
- `get-shit-done/workflows/ship.md`

## Doc map

- [`01-system-model.md`](./01-system-model.md) — what GSD is architecturally, how orchestration works, and why `.planning/` is central
- [`02-bootstrap-and-project-init.md`](./02-bootstrap-and-project-init.md) — step-by-step project bootstrap flow, including brownfield codebase mapping and `/gsd-new-project`
- [`03-phase-delivery-loop.md`](./03-phase-delivery-loop.md) — the per-phase workflow from discussion through planning, execution, verification, gaps, and shipping
- [`04-artifacts-and-routing.md`](./04-artifacts-and-routing.md) — persistent artifacts, command responsibilities, `/gsd-next` routing, and milestone progression

## Shortest accurate summary

Mainline lifecycle:

1. Optional `/gsd-map-codebase` for existing projects
2. `/gsd-new-project`
3. For each roadmap phase:
   - `/gsd-discuss-phase`
   - optional `/gsd-ui-phase`
   - `/gsd-plan-phase`
   - `/gsd-execute-phase`
   - `/gsd-verify-work`
   - optional `/gsd-ship`
4. `/gsd-next` can route to the next logical step by inspecting `.planning/`
5. After all phases: audit/complete the milestone, then optionally start a new milestone

## Core idea

GSD is a file-driven workflow system, not just a prompt set. Its commands and workflow files continuously read and write structured Markdown state under `.planning/`, then spawn specialized fresh-context agents against those artifacts.

Most important artifact chain:

`PROJECT.md` → `REQUIREMENTS.md` → `ROADMAP.md` → `CONTEXT.md` / `RESEARCH.md` / `UI-SPEC.md` / `VALIDATION.md` / `PATTERNS.md` → `PLAN.md` → `SUMMARY.md` → `VERIFICATION.md` / `UAT.md`
