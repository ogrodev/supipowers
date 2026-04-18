# Lessons from AutoBE for supipowers

## Short answer

The main lesson is not "use better prompts."

The main lesson is:

> make AI produce constrained intermediate artifacts, validate them immediately, deterministically render the final output where possible, and repair against validator feedback instead of trusting one-shot prose.

AutoBE applies that pattern to backend generation. supipowers should apply the same pattern to agent orchestration.

## What supipowers should copy

### 1. Structure-first generation, not prompt-first generation

AutoBE gets reliability by making the model emit typed intermediate structures before code.

supipowers already does a version of this in the review pipeline:

- `src/review/types.ts`
  - TypeBox schemas define `ReviewOutput`, `ReviewFixOutput`, `ReviewSession`, and related structures.
- `src/review/output.ts`
  - `runWithOutputValidation()` retries invalid outputs and validates them against schemas.
- `src/review/runner.ts`
- `src/review/multi-agent-runner.ts`
- `src/review/validator.ts`
- `src/review/fixer.ts`
  - all use the same structured-output loop.

That is the strongest AutoBE-like subsystem in the repo today.

The lesson is to make this the default for *all* AI-powered commands, not just review.

### 2. Validation should be a first-class phase, not a best-effort afterthought

AutoBE continuously validates each phase artifact before moving on.

supipowers already has the building blocks:

- TypeBox schemas
- deterministic quality gates
- LSP diagnostics integration
- persisted session artifacts

But several commands still accept free-form output and only parse it once, or fall back to manual handling.

Examples:

- `src/git/commit.ts`
  - `parseCommitPlan()` parses a fenced JSON block, but there is no generic repair loop; failure falls back to manual input.
- `src/quality/gates/ai-review.ts`
  - parses a JSON payload once and blocks on invalid output.
- `src/quality/ai-setup.ts`
  - parses once, validates once, throws on invalid output.
- `src/docs/drift.ts`
  - asks for JSON, but `parseDriftFindings()` uses regex extraction and a heuristic fallback that treats unparseable prose as possible drift.
- `src/commands/release.ts`
  - release-note polish and doc-fix flows call `runStructuredAgentSession()` directly and accept raw text without a typed contract.

AutoBE’s lesson is clear: parse errors should trigger correction, not improvisation.

### 3. One source of truth for schemas

AutoBE derives LLM-facing schemas from code types.

supipowers still duplicates output contracts in multiple places:

- `src/review/types.ts`
  - canonical TypeBox schemas exist.
- `src/review/prompts/review-output-schema.md`
  - a hand-maintained prompt-side schema copy also exists.
- `src/quality/gates/ai-review.ts`
  - manually embeds a JSON shape as prompt text.
- `src/quality/ai-setup.ts`
  - manually describes the `QualityGatesConfig` shape in prose.
- `src/git/commit.ts`
  - manually embeds the commit-plan JSON shape in the prompt.
- `src/docs/drift.ts`
  - manually embeds a JSON response shape in the prompt.

This is schema drift waiting to happen.

The AutoBE lesson is to generate prompt-visible schema text from the actual runtime schema, or at least centralize it behind one code path.

### 4. Deterministic rendering should replace free-form final formatting

AutoBE lets the model choose structure, then deterministic code generators produce the final artifacts.

supipowers should do the same anywhere the final format is predictable.

Best examples:

- Plans:
  - current flow in `src/commands/plan.ts` sends a free-form planning prompt.
  - `src/storage/plans.ts` later parses markdown back into `PlanTask[]` using regex.
  - this is the opposite of AutoBE’s pattern.
  - Better pattern: generate a typed `PlanSpec`, validate it, then render markdown deterministically.

- Commit plans:
  - `src/git/commit.ts` already expects structured JSON, which is good.
  - next step is to make the schema canonical and validated with retries instead of regex + null.

- Doc drift findings:
  - findings should be validated as typed objects before any fix prompt is built.

The big principle: let the model decide *content*, not *format syntax*, when syntax is already known.

### 5. Phase-gated workflows reduce hallucination

AutoBE enforces ordered phases with prerequisites.

supipowers has commands that would benefit from the same explicit phase separation.

#### `/supi:plan`
Recommended phases:
1. collect request context
2. generate typed plan artifact
3. validate task coverage / file references / complexity labels
4. render markdown
5. approval
6. execution handoff

Today it is effectively:
1. send planning prompt
2. wait for a markdown file to appear
3. parse markdown back into structure later if needed

That works, but it is less reliable than a typed artifact pipeline.

#### `/supi:fix-pr`
Recommended phases:
1. fetch comments
2. produce typed assessment per comment (`accept` / `reject` / `investigate`, rationale, affected files, verification plan)
3. cluster approved work items deterministically
4. execute
5. verify
6. optionally reply

Today `src/fix-pr/prompt-builder.ts` describes those steps in prose, but the assessment itself is not captured as a validated intermediate artifact.

#### `/supi:release`
Recommended phases:
1. discover target and release inputs
2. validate changelog inputs and channel availability
3. optionally polish notes under a typed contract
4. execute release
5. verify pushed tag/channel results

The current release flow is strong on deterministic execution, but weaker on structured AI artifacts around note polishing and doc fixing.

## What supipowers should *not* copy blindly

### 1. Do not copy AutoBE’s exact compiler architecture

AutoBE is a backend generator. supipowers is an OMP extension and orchestration layer.

supipowers does not need:

- AST compilers for everything
- a five-stage facade for every command
- a complex codegen stack

The reusable lesson is the reliability pattern:

- typed intermediate forms
- generated or centralized schemas
- immediate validation
- targeted retries
- deterministic rendering/execution

not AutoBE’s exact package architecture.

### 2. Do not overclaim beyond verified guarantees

AutoBE’s repo is strongest on buildability, weaker on universal runtime correctness.

supipowers should adopt the same discipline in how it talks about itself:

- claim what is verified
- separate "schema-valid" from "actually correct"
- separate "review completed" from "finding confirmed"
- separate "release notes polished" from "release correctness verified"

This fits supipowers’ existing verification philosophy better than aspirational UX language.

## Highest-leverage improvements for supipowers

## Priority 1 — Generalize the review pipeline’s structured-output loop

This is the single best lesson to port.

Build one reusable helper for:

- prompt construction
- schema validation
- retry-on-invalid-output
- normalization
- artifact persistence

Then migrate these flows to it:

1. `src/git/commit.ts`
2. `src/quality/gates/ai-review.ts`
3. `src/quality/ai-setup.ts`
4. `src/docs/drift.ts`
5. AI-assisted pieces in `src/commands/release.ts`

Why first:

- lowest conceptual risk
- highest reliability gain
- matches a pattern already proven in `src/review/*`

## Priority 2 — Make planning schema-first

Introduce a typed plan artifact, something like `PlanSpec`, as the real output of planning.

Then:

- validate it before saving
- render markdown deterministically
- keep markdown as a human UI artifact, not the canonical representation

Why this matters:

- `src/storage/plans.ts` currently reconstructs tasks from markdown regex
- that is brittle, lossy, and easy to drift
- planning is one of supipowers’ flagship workflows, so reliability here matters disproportionately

## Priority 3 — Eliminate schema duplication in prompts

Use one canonical schema source.

Good candidates:

- generate prompt-facing JSON schema text from TypeBox
- or build small helpers that render example JSON from TypeBox-backed definitions

Targets:

- review output schema prompts
- commit plan schema text
- AI review gate payload
- AI quality setup payload
- doc drift payload

Why this matters:

- lower maintenance burden
- fewer prompt/schema mismatches
- more AutoBE-like “compiler is the contract” behavior

## Priority 4 — Add deterministic post-AI verification everywhere

AutoBE trusts compilers more than model self-reports.

supipowers should do the equivalent with the tools it already has:

- LSP diagnostics
- configured quality gates
- git state checks
- workspace target resolution
- file existence / changed-file coverage checks

Examples:

- commit plans should verify every staged file is covered exactly once before approval
- plan execution handoff should verify plan tasks are structurally valid before starting execution
- doc drift findings should verify referenced docs exist and related files are plausible
- fix-pr assessments should verify referenced file paths and line anchors before execution

## Priority 5 — Build an evaluation harness for supipowers commands

AutoBE has an explicit estimate/evaluation package.

supipowers should add command-level scorecards, especially for AI-heavy workflows:

- review parse success rate
- review validator agreement rate
- auto-fix success vs regression rate
- plan approval/edit/rejection rate
- commit-plan parse/retry/manual-fallback rate
- doc-drift false-positive rate
- fix-pr accepted vs rejected comment handling accuracy

The repo already persists useful artifacts for review sessions. Extend that idea across commands and measure quality empirically.

This is how prompt and model changes become engineering decisions instead of anecdotes.

## A concrete product lesson

The deepest AutoBE lesson is this:

> reliability comes from moving the LLM away from being the final authority.

In AutoBE, the model proposes structure; validators and compilers decide whether the structure is acceptable.

For supipowers, that translates to:

- the model should propose plans, findings, fix records, or changelog edits
- schemas, LSP, git, test commands, and command-specific invariants should decide whether those proposals are acceptable

That philosophy already exists in the review subsystem.
The next step is to make it the design default for the rest of the extension.

## Bottom line

If I were improving supipowers based on AutoBE, I would not start by changing prompts.

I would do this:

1. make every AI command emit a typed artifact
2. validate and retry invalid artifacts automatically
3. render final human-facing formats deterministically when possible
4. gate each workflow with deterministic checks
5. measure the real success rate of each command

In one sentence:

> make supipowers less like a collection of smart prompts and more like a validated orchestration compiler for agent workflows.
