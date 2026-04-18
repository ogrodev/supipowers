# Chunk 04 — tool contracts and prompt hardening

## Objective

Make supipowers’ tool interfaces and orchestration prompts easier for the model to use correctly and harder to misuse.

## Why this chunk exists

The ForgeCode research indicates that small changes to tool contracts can materially change agent behavior: flatter schemas, clearer required fields, better tool descriptions, and tighter prompts all reduce wasted turns.

Supipowers has several high-leverage surfaces where this matters:
- native context-mode tools in `src/context-mode/tools.ts`
- MCP management tool registration in `src/bootstrap.ts`
- planning-mode prompt assembly in `src/planning/system-prompt.ts`
- markdown-backed review agents in `src/review/default-agents/*.md`
- orchestrator prompts for QA and fix-pr referenced by `src/commands/qa.ts` and `src/commands/fix-pr.ts`

## Current gap

Supipowers has a strong tool surface, but some of it is large and parameter-rich. That increases the chance of:
- wrong field names
- over-nested inputs
- unclear tool-choice boundaries
- duplicated or bloated prompt instructions that cost tokens without adding clarity

## Proposed work

1. Audit the highest-value tool schemas first:
   - `ctx_execute`
   - `ctx_execute_file`
   - `ctx_batch_execute`
   - `ctx_search`
   - `planning_ask`
   - `mcpc_manager`
2. Simplify parameter shapes where possible:
   - flatten nested inputs that do not earn their complexity
   - standardize required vs optional fields
   - keep names short and concrete
3. Audit prompt snippets and guidance text so the model gets a sharper answer to:
   - when should I use this tool?
   - when should I not use it?
   - what is the preferred path if more than one tool could work?
4. Tighten the longest workflow prompts:
   - remove duplicated prohibitions
   - keep the truly critical invariants
   - prefer concrete directives over motivational prose
5. Add rendering tests or snapshots for prompt builders so future prompt edits have an explicit review surface.

## Likely files and modules

- `src/context-mode/tools.ts`
- `src/bootstrap.ts`
- `src/planning/system-prompt.ts`
- `src/review/default-agents/correctness.md`
- `src/review/default-agents/maintainability.md`
- `src/review/default-agents/security.md`
- prompt-builder modules under `src/qa/` and `src/fix-pr/`
- tests under `tests/context-mode/`, `tests/planning/`, `tests/review/`, `tests/qa/`, and `tests/fix-pr/`

## Test plan

Automated checks for this chunk should include:
- schema-level tests for the audited tools
- prompt rendering tests for planning/review/QA/fix-pr builders
- behavior evals proving preferred tool selection still happens after the schema changes
- regression tests ensuring no required field was removed accidentally

Good concrete checks:
- tool descriptions still express the preferred path clearly
- prompt rendering still contains required hard gates but sheds duplicated text
- planning and context-mode tests still pass after prompt/schema tightening

## Exit criteria

This chunk is done when:
- the highest-value tool contracts are simpler and consistently structured
- prompt text is shorter without losing required behavior
- there is automated coverage for both schema shape and prompt rendering
- evals show the tightened contracts improve tool-choice reliability rather than merely changing wording

## Non-goals

- rewriting every prompt in the repo at once
- optimizing for token count alone while sacrificing clarity
- changing stable public behavior just to chase cosmetic consistency

## Dependencies

Best paired with chunk 01 so the schema and prompt changes can be evaluated behaviorally, not just aesthetically.
