# Why AutoBE achieves high buildability

## Core thesis
AutoBE increases backend success rates by moving failure detection as far left as possible.

Instead of waiting until after full source generation to discover problems, it inserts validation at multiple layers:

1. typed function-calling schemas
2. AST-level validation
3. deterministic artifact generation
4. compiler checks after generation
5. targeted rewrite loops on failure

That is the practical answer to "how can they produce 100% working backends?"

With one important correction:

- the repo strongly supports **100% compilable/buildable backends**,
- not **100% semantically correct backends in all runtime situations**.

## 1. Constrained output space
The single most important technique is reducing what the model is allowed to generate.

### Naive approach
Ask an LLM for Prisma/OpenAPI/NestJS/TypeScript files directly.

### AutoBE approach
Ask the model for typed structures such as:
- `AutoBeDatabase.IApplication`
- `AutoBeOpenApi.IDocument`
- `AutoBeTest.IFunction`

Those structures have explicit constraints, naming rules, and documented semantics.

### Why it works
Most generation failures happen because the model has too much freedom. AutoBE removes much of that freedom.

### Evidence
- `website/src/content/docs/concepts/function-calling.mdx`
  - AutoBE prefers AST generation via function calling over raw code text.
- `packages/interface/src/database/AutoBeDatabase.ts`
  - names, roles, and shape rules are encoded in the type system.
- `packages/interface/src/openapi/AutoBeOpenApi.ts`
  - API naming, auth, schema, and documentation rules are encoded in types/comments.
- `packages/interface/src/test/AutoBeTest.ts`
  - test AST limits what statements/expressions are valid and how they must be composed.

## 2. Compiler-generated schemas and validators
AutoBE does not hand-author the function-calling schema for these ASTs.

It uses `typia.llm.application<...>()` to generate them from TypeScript types.

### Why that matters
Hand-authored tool schemas drift. Compiler-generated schemas stay aligned with the actual types.

### What it gives them
- consistent function-call shape
- runtime validation
- descriptions derived from comments
- less schema drift between prompt and implementation

### Evidence
- `website/src/content/docs/concepts/function-calling.mdx`
  - says `typia` generates both LLM schemas and validation functions.
  - says AST comments become descriptions in the generated schemas.
- `packages/agent/src/orchestrate/...`
  - many orchestrators instantiate `typia.llm.application<...>()` directly.
- `packages/agent/src/orchestrate/facade/createAutoBeFacadeController.ts`
  - even the top-level facade function API is generated this way.

## 3. AST-level semantic validation before text generation
AutoBE validates more than syntax.

### Database example
The database compiler validates the AST for semantic issues such as:
- duplicate files
- duplicate models
- duplicate fields
- duplicate indexes
- invalid references
- relation issues

### Why this matters
Prisma text could be syntactically valid but still structurally wrong. AST validation catches that earlier.

### Evidence
- `packages/compiler/src/database/validateDatabaseApplication.ts`
  - implements semantic validation passes over the DB AST.
- `packages/compiler/src/database/AutoBeDatabaseCompiler.ts`
  - exposes both `validate()` and `compilePrismaSchemas()`.

## 4. Deterministic code generation from validated structures
Once the AST passes validation, code generation is deterministic.

### Database
Validated DB AST → Prisma schema files

### Interface
Validated API AST → OpenAPI document → NestJS project + SDK + swagger

### Why this matters
If generation is deterministic, the hard problem shifts from "can the model write correct source?" to "can the model produce a valid intermediate structure?"

That is a much smaller problem.

### Evidence
- `packages/compiler/src/database/AutoBeDatabaseCompiler.ts`
  - writes Prisma schemas from the AST.
- `packages/compiler/src/interface/AutoBeInterfaceCompiler.ts`
  - transforms the interface AST and generates NestJS code + swagger.
- `website/src/content/docs/concepts/compiler.mdx`
  - explicitly frames the system as "structure first, validate continuously, generate deterministically."

## 5. Correction loops are compiler-driven, not just prompt retries
AutoBE does not simply say "try again".
It retries with concrete failure signals.

### Database correction
Observed loop:
1. validate DB AST
2. if invalid, write Prisma schemas and compile them
3. dispatch validation event
4. ask for correction
5. merge corrected models
6. validate again
7. repeat until success or retry budget exhausted

### Evidence
- `packages/agent/src/orchestrate/database/orchestrateDatabaseCorrect.ts`
  - recursive `iterate(..., DATABASE_CORRECT_RETRY)` loop.
  - writes/compiles Prisma schemas on failure.
  - asks for corrections and revalidates.

### Realize correction
Observed loop:
1. write functions
2. correct casting/import shape
3. perform overall correction
4. compile realization output in-project
5. retry failed endpoints only

### Evidence
- `packages/agent/src/orchestrate/realize/orchestrateRealizeOperation.ts`
  - uses `orchestrateRealizeCorrectWithRetry`.
- `packages/agent/src/orchestrate/realize/correct/orchestrateRealizeCorrectWithRetry.ts`
  - processes initial write, partitions success/failure, retries failed functions.
- `packages/agent/src/orchestrate/realize/programmers/compileRealizeFiles.ts`
  - compiles generated functions together with template files, existing `src/*.ts`, and Prisma client files.

### Test correction
Observed loop:
1. write procedures
2. run casting/import repair
3. run overall correction guarded by `typia.validate(...)`
4. use programmer-specific validation before accepting rewrites

### Evidence
- `packages/agent/src/orchestrate/test/orchestrateTestGenerate.ts`
- `packages/agent/src/orchestrate/test/orchestrateTestOperation.ts`

## 6. In-project compilation matters more than isolated compilation
AutoBE does not merely compile snippets in isolation.

At realization time it compiles generated output together with:
- current project `src/*.ts` files
- templates
- additional generated files
- Prisma client files, when available

### Why this matters
A lot of codegen systems can generate locally valid fragments that fail once integrated. AutoBE explicitly checks integrated buildability.

### Evidence
- `packages/agent/src/orchestrate/realize/programmers/compileRealizeFiles.ts`
  - assembles a full compile input from project files plus generated artifacts.
- `packages/compiler/src/AutoBeTypeScriptCompiler.ts`
  - performs the final TypeScript validation layer.

## 7. Tests are part of the generation strategy, not just a separate QA step
AutoBE generates test scaffolds from the interface phase, then strengthens them in the test phase.

### Why this helps
- the API contract and the tests come from the same structured source
- realization can be checked against those tests
- the model gets another concrete artifact describing intended behavior

### Evidence
- `website/src/content/docs/concepts/waterfall.mdx`
  - Interface generates E2E scaffolds.
  - Test enhances them with dependency-aware scenarios.
  - Realize receives runtime feedback from test execution.
- `packages/agent/src/orchestrate/test/orchestrateTest.ts`
  - compiles the generated test suite.

## 8. Benchmarking is separate and later
The benchmark/evaluation system is not the main generation engine.
It is a post-generation scoring pipeline.

### What it evaluates
- gate checks: syntax, types, Prisma, optional runtime
- scoring phases: documentation, requirements coverage, test coverage, logic completeness, API completeness
- optional golden-set and contract tests

### Why that matters
This improves confidence and helps compare models, but it does not itself create the buildability guarantee.

### Evidence
- `packages/estimate/src/core/pipeline.ts`
  - runs gate first, then scoring phases.
  - can stop evaluation on gate failure.
  - only runs runtime/golden logic when enabled by options/context.
- `packages/estimate/README.md`
  - documents runtime and golden evaluation as options.

## 9. What AutoBE actually guarantees best
### Strongest practical guarantee
"The generated backend can be made to compile/build within the supported stack."

This is well supported by:
- AST constraints
- compiler-generated function schemas
- semantic validators
- deterministic code generation
- compiler-driven correction loops
- in-project compile checks

### Weaker guarantee
"The backend fully satisfies all business requirements and behaves correctly in production."

This is not fully proven by the observed repo.

## 10. The decisive distinction
When AutoBE says "100% working," the codebase shows that the reliable core is:

- **working as code artifacts**
- **working as compilable/generated backend projects**

not necessarily:

- **working in every runtime path**
- **working for every business edge case**
- **working securely and correctly without further verification**

## Final answer
AutoBE can achieve very high backend success rates because it transforms backend generation from an unconstrained text-generation problem into a constrained compilation problem.

That is the essence.

Its strongest claim is not magic semantic reasoning. It is that the system is built so the model keeps producing structures that are:
- typed,
- validated,
- compiled,
- repaired,
- and recompiled,

until the result fits the stack.
