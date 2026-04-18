---
name: autobe-chunk-2-schema-first-planning
created: 2026-04-17
tags: [autobe, improvement-plan, planning, reliability]
---

# Chunk 2: Schema-first planning cutover

## Goal

Make planning produce a validated `PlanSpec` artifact first, then render markdown deterministically, instead of treating markdown as the canonical artifact and re-parsing it later with regex.

## Why this chunk exists

Current planning flow is structurally backwards for a reliability-focused system:

- `src/commands/plan.ts` sends a free-form planning prompt
- the agent writes markdown
- `src/storage/plans.ts` later reconstructs tasks from markdown using regex parsing

That is workable, but it is the opposite of the AutoBE lesson. The source of truth should be typed structure; markdown should be the human-facing rendering.

## Non-goals

- Do not redesign the planning UI or approval choices.
- Do not change the final saved file format away from markdown.
- Do not add backward-compatibility shims that keep two canonical plan representations alive.

## Chunk acceptance

This chunk is complete when:

- planning has a typed `PlanSpec` contract in code
- plan generation validates the artifact before saving anything
- saved markdown is rendered from the validated spec
- the approval flow executes the rendered plan that was saved
- round-trip tests prove the renderer and parser stay aligned

## Tasks

### 1. Introduce canonical planning contracts and validation

- **files**:
  - Modify: `src/types.ts`
  - Create: `src/planning/spec.ts`
  - Create: `src/planning/validate.ts`
  - Modify: `src/planning/prompt-builder.ts`
  - Create: `tests/planning/spec.test.ts`
  - Create: `tests/planning/validate.test.ts`
- **criteria**: planning defines one typed artifact for context, tasks, complexity, file lists, and acceptance criteria; invalid artifacts are rejected before rendering or approval.
- **complexity**: large

Suggested verification:
- `bun test tests/planning/spec.test.ts tests/planning/validate.test.ts`
- `bun run typecheck`

### 2. Render markdown deterministically from the validated plan artifact

- **files**:
  - Create: `src/planning/render-markdown.ts`
  - Modify: `src/storage/plans.ts`
  - Modify: `tests/storage/plans.test.ts`
  - Create: `tests/planning/render-markdown.test.ts`
- **criteria**: markdown is generated from `PlanSpec` through one renderer; `src/storage/plans.ts` can parse the rendered markdown without losing task IDs, names, files, criteria, or complexity.
- **complexity**: medium

Suggested verification:
- `bun test tests/storage/plans.test.ts tests/planning/render-markdown.test.ts`
- `bun run typecheck`

### 3. Cut `/supi:plan` and approval flow over to the schema-first artifact

- **files**:
  - Modify: `src/commands/plan.ts`
  - Modify: `src/planning/approval-flow.ts`
  - Modify: `src/planning/system-prompt.ts`
  - Modify: `src/storage/plans.ts`
  - Modify: `tests/commands/plan.test.ts`
  - Modify: `tests/planning/approval-flow.test.ts`
- **criteria**: plan generation retries or blocks on invalid `PlanSpec` output, saves markdown rendered from the validated artifact, and the approval flow executes the saved markdown without rebuilding task structure from ad-hoc prose.
- **complexity**: large

Suggested verification:
- `bun test tests/commands/plan.test.ts tests/planning/approval-flow.test.ts tests/storage/plans.test.ts`
- `bun run typecheck`

## Risks to watch

- accidentally preserving both a raw-markdown source of truth and a `PlanSpec` source of truth
- letting the renderer drift from the parser
- weakening current approval-flow behavior while moving plan generation earlier

## Exit criteria

After this chunk, planning should behave like this:

1. model emits `PlanSpec`
2. code validates `PlanSpec`
3. code renders markdown deterministically
4. markdown is saved and approved
5. execution handoff uses the approved, rendered artifact

That is the planning equivalent of AutoBE’s structure-first pipeline.
