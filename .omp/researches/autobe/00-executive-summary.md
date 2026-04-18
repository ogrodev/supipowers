# AutoBE research: executive summary

## Short answer
AutoBE does not get to "100% working backends" by asking an LLM to write a full backend as free-form code.

It gets there by aggressively constraining generation:

1. It decomposes backend creation into a staged waterfall pipeline: Analyze → Database → Interface → Test → Realize.
2. In the early phases, the model produces typed AST/data structures through function calling instead of raw Prisma/OpenAPI/TypeScript text.
3. Those ASTs are validated by compilers and custom validators before code generation.
4. When validation fails, the failure is fed back into targeted correction loops and retried.
5. Only after the structured artifacts are valid does AutoBE generate Prisma schemas, OpenAPI, NestJS code, test scaffolds, and realization code.
6. Later phases compile generated code in-project and, in some flows, run test programs for additional feedback.

That combination materially raises the probability of a buildable backend.

## The most important finding
In the repository, the strongest proven guarantee is **buildability / compilation success**, not universal semantic correctness.

The repo itself says this explicitly:

- README: generated backends are designed to be **"100% buildable by AI-friendly compilers"**.
- README: AutoBE currently has **"100% compilation success rate"**.
- README: **runtime behavior may still require testing and refinement**, and **v1.0 targets 100% runtime success**.

So the accurate interpretation is:

- AutoBE is engineered to produce **consistently compilable backends**.
- It is **not yet proven to always produce behaviorally correct backends** in the full production sense.

## Why the approach works better than naive code generation
AutoBE narrows the search space and forces correctness checks earlier:

- **Structure-first generation**: the model emits `AutoBeDatabase.IApplication`, `AutoBeOpenApi.IDocument`, and `AutoBeTest.IFunction`-style structures instead of unrestricted source text.
- **Compiler-generated schemas**: `typia.llm.application<...>()` derives function-calling schemas and validators from TypeScript types and comments.
- **Stage-specific compilers**:
  - Prisma compiler for DB schema validation/generation
  - OpenAPI/NestJS compiler for interface generation
  - TypeScript compiler for final integration checks
- **Targeted retry loops**: database correction, test correction, and realize correction use validation/compiler feedback to retry only failed parts.
- **Spec-driven tests**: tests are generated from the same interface artifacts, so the realization phase is checked against the API contract it is supposed to implement.

## What AutoBE can defend today
### Strongly supported by code/docs
- High confidence that generated outputs can be made **syntactically valid**.
- High confidence that generated backend code can be made **TypeScript-compilable in-project**.
- Strong evidence of **iterative self-correction using compiler feedback**.
- Strong evidence of **optional runtime and benchmark evaluation** after generation.

### Not fully guaranteed by the observed repo
- Perfect business-logic correctness
- Perfect runtime behavior under all environments
- Full requirements satisfaction in every generated project
- Security correctness by construction

## Core repo evidence
- `README.md` — claim narrowed to buildability; limitations admit runtime gaps.
- `packages/agent/src/AutoBeAgent.ts` — central five-phase orchestrator.
- `packages/agent/src/orchestrate/facade/createAutoBeFacadeController.ts` — phase gating and compiled-result-centric outcomes.
- `website/src/content/docs/concepts/function-calling.mdx` — AST via function calling, typia-generated schemas/validators, comments-as-rules.
- `website/src/content/docs/concepts/waterfall.mdx` — staged pipeline and feedback loops.
- `website/src/content/docs/concepts/compiler.mdx` — three-tier compiler architecture.
- `packages/agent/src/orchestrate/database/orchestrateDatabaseCorrect.ts` — recursive schema correction loop.
- `packages/agent/src/orchestrate/realize/programmers/compileRealizeFiles.ts` — in-project TypeScript compile of generated realization output.
- `packages/estimate/src/core/pipeline.ts` — post-generation evaluation/benchmark pipeline.

## Bottom line
AutoBE's "100% working" story is really a **compiler-constrained backend generation system**.

Its edge is not a smarter prompt. Its edge is that it turns backend generation into:

- typed intermediate representations,
- deterministic codegen,
- compiler-driven feedback,
- and repeated repair.

That is enough to plausibly support **100% compilation success**.
It is **not the same thing as 100% runtime or business correctness**, and the repository explicitly acknowledges that distinction.
