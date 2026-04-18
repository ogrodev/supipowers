# Claims vs evidence

## The question to keep straight
When people say AutoBE produces "100% working backends," they could mean at least four different things:

1. the output parses
2. the output compiles/builds
3. the output passes generated tests
4. the output is behaviorally correct for real users in production

The repository does **not** support all four equally.

## What is strongly evidenced

### A. 100% buildable / compilable is the central claim
This wording appears repeatedly and matches the mechanics in the codebase.

### Evidence
- `README.md`
  - "The generated backend application is designed to be 100% buildable by AI-friendly compilers..."
- `README.md`
  - "This approach is designed to ensure that the final generated TypeScript and Prisma code is 100% buildable."
- `website/src/content/docs/concepts/compiler.mdx`
  - centers the architecture on compiler-backed AST validation and generation.
- `packages/agent/src/orchestrate/facade/createAutoBeFacadeController.ts`
  - phase outcomes are expressed in terms of `history.compiled.type` for database/test/realize.

## What is partially evidenced

### B. Higher runtime confidence through tests and iterative correction
The docs and code clearly show that runtime/test feedback exists or is intended in later phases.

### Evidence
- `website/src/content/docs/concepts/waterfall.mdx`
  - Test enhances E2E scaffolds.
  - Realize receives compilation feedback and runtime feedback.
- `packages/agent/src/orchestrate/test/orchestrateTest.ts`
  - compiles generated tests.
- `packages/estimate/src/core/pipeline.ts`
  - optional runtime/golden/contract evaluation exists after generation.

### Limitation
This is confidence-building, not a formal proof of correctness.

## What the repo explicitly does **not** guarantee yet

### C. Universal runtime correctness
The README directly weakens the stronger marketing narrative.

### Evidence
- `README.md`
  - "While AutoBE achieves 100% compilation success, please note these current limitations..."
- `README.md`
  - runtime behavior may require testing and refinement.
- `README.md`
  - unexpected runtime errors can still occur.
- `README.md`
  - v1.0 targets 100% runtime success, implying it is not already achieved.

## Why benchmark scores matter
The benchmark is useful because it exposes the gap between "compiles" and "fully good backend."

### Observed scoring categories
- documentation quality
- requirements coverage
- test coverage
- logic completeness
- API completeness
- optional golden set
- AI review dimensions such as security/hallucination/code quality

### Why this matters
If AutoBE already guaranteed full behavioral correctness, these downstream scoring phases would be much less necessary.

### Evidence
- `README.md`
  - benchmark table shows averages below 100.
- `packages/estimate/README.md`
  - describes weighted evaluation phases beyond compilation.
- `packages/estimate/src/core/pipeline.ts`
  - separates gate checks from scoring checks.

## The practical interpretation of "100% working"

### Best-faith interpretation
AutoBE is engineered so that the generated backend is highly likely to be:
- structurally valid,
- stack-compatible,
- and compilable within the supported TypeScript/Prisma/NestJS ecosystem.

### Overstatement to avoid
AutoBE does **not** currently prove that every generated backend:
- implements all business logic correctly,
- is free of runtime bugs,
- is secure by construction,
- or is production-ready without human verification.

## Where the marketing is stronger than the code
Some documentation language says generated apps "work correctly on the first attempt" and are "production-ready."
Those statements are stronger than the explicit limitation section and stronger than the visible enforcement logic.

### Evidence
- `website/src/content/docs/concepts/compiler.mdx`
  - uses strong language around first-attempt correctness and deployability.
- `README.md`
  - later tempers that with runtime limitations and a future runtime-success target.

## What a precise statement would be
A precise, code-defensible version of the claim would be:

> AutoBE is designed to achieve near-100% compilation/build success for generated TypeScript backends by generating typed intermediate ASTs, validating them with compilers and custom rules, and iteratively repairing failures with compiler feedback. Runtime and business correctness are improved through generated tests and evaluation pipelines, but are not universally guaranteed today.

## Final verdict
### Yes
AutoBE has a real, nontrivial technical answer for why its backend outputs are unusually reliable:
- typed AST generation,
- compiler-generated schemas,
- semantic validation,
- deterministic codegen,
- targeted repair loops,
- integrated compile/test checks.

### No
The repository does not justify reading "100% working backends" as "100% production-correct backends."

The defensible reading is **100% compilation success / buildable backend generation**, with runtime correctness still treated as an active improvement area.
