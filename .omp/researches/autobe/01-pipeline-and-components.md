# How AutoBE works

## 1. System shape
AutoBE is a facade over a fixed backend-generation pipeline, not a single monolithic "generate backend" step.

Observed phases:

1. Analyze
2. Database
3. Interface
4. Test
5. Realize

### Evidence
- `packages/agent/src/AutoBeAgent.ts`
  - documents `AutoBeAgent` as the coordinator for five specialized agents.
- `packages/agent/src/orchestrate/facade/createAutoBeFacadeController.ts`
  - exposes `analyze`, `database`, `interface`, `test`, `realize` as facade operations.
  - prevents later phases from running before prerequisites are satisfied.
- `README.md`
  - shows the recommended flow as Requirements Analysis → Database Design → API Specification → Testing → Implementation.

## 2. The facade orchestrates phase entry and phase order
The facade controller does not let the model freely jump around. Each phase has an explicit entry point and prerequisite logic.

### What the controller does
- `analyze`: starts requirements work.
- `database`: only valid after analysis.
- `interface`: only valid after database.
- `test`: only valid after interface.
- `realize`: only valid after interface.

### Why this matters
This cuts down combinatorial failure. Each phase receives a narrower, better-defined input artifact.

### Evidence
- `packages/agent/src/orchestrate/facade/createAutoBeFacadeController.ts`
  - `database` returns `prerequisites-not-satisfied` when analysis is incomplete.
  - `interface` waits for database.
  - `test` and `realize` wait for interface.

## 3. AutoBE uses typed intermediate artifacts, not just code text
The core design choice is to have the model produce typed structures through function calling.

Key artifact types:

- Database AST: `AutoBeDatabase.IApplication`
- Interface AST: `AutoBeOpenApi.IDocument`
- Test AST: `AutoBeTest.IFunction`

### Why this matters
If the model generates raw code, every token can be wrong. If the model generates typed structures, the system can validate structure before generating text.

### Evidence
- `packages/interface/src/database/AutoBeDatabase.ts`
  - defines the database AST hierarchy.
- `packages/interface/src/openapi/AutoBeOpenApi.ts`
  - defines the API/interface AST hierarchy.
- `packages/interface/src/test/AutoBeTest.ts`
  - defines the test-function AST hierarchy.
- `website/src/content/docs/concepts/function-calling.mdx`
  - states that AutoBE prefers AST generation through function calling over raw code text.

## 4. `typia` is the schema engine behind function calling
AutoBE relies on `typia.llm.application<...>()` to generate function-calling schemas and runtime validators from TypeScript types.

### What this buys them
- one source of truth for structure
- automatic validator generation
- comments/rules attached to the types flow into model-visible descriptions

### Evidence
- `website/src/content/docs/concepts/function-calling.mdx`
  - says AutoBE uses `typia` to generate AI function-calling schemas at compiler level.
  - says those compilers also generate validation functions.
  - says coding rules are embedded in AST type comments and become type descriptions.
- `packages/agent/src/orchestrate/...`
  - many phase controllers build schemas with `typia.llm.application<...>()`.
- `packages/interface/src/database/AutoBeDatabase.ts`
  - comments encode rules such as naming, role semantics, and English-only descriptions.
- `packages/interface/src/openapi/AutoBeOpenApi.ts`
  - comments encode API naming, authorization, schema, and documentation rules.
- `packages/interface/src/test/AutoBeTest.ts`
  - comments encode AST usage rules, statement restrictions, and test-construction constraints.

## 5. Phase-by-phase behavior

### Analyze
Purpose: turn conversation into structured requirements artifacts.

Observed behavior:
- analysis uses retries and validation before accepting the scenario.
- later generation phases depend on its output.

Evidence:
- `packages/agent/src/orchestrate/analyze/orchestrateAnalyze.ts`
  - validates scenario basics.
  - retries scenario generation when the pre-check fails.
  - performs deterministic and staged assembly after scenario creation.

### Database
Purpose: convert requirements into database AST, validate it, then generate Prisma schemas.

Evidence:
- `packages/agent/src/orchestrate/database/orchestrateDatabase.ts`
  - builds groups, components, and schema AST.
  - runs `orchestrateDatabaseCorrect`.
  - writes Prisma files and compiles them.
- `packages/compiler/src/database/AutoBeDatabaseCompiler.ts`
  - validates AST and compiles generated Prisma schemas.
- `packages/compiler/src/database/validateDatabaseApplication.ts`
  - implements semantic checks like duplicate files/models/fields/indexes and invalid references.

### Interface
Purpose: convert requirements + DB knowledge into API/interface AST, then generate OpenAPI + NestJS.

Evidence:
- `packages/agent/src/orchestrate/interface/orchestrateInterface.ts`
  - builds groups, authorizations, endpoints, operations, schemas, prerequisites.
  - finalizes an `AutoBeOpenApi.IDocument`.
- `packages/compiler/src/interface/AutoBeInterfaceCompiler.ts`
  - converts the AST into OpenAPI, then into a NestJS project, SDK, and swagger output.

### Test
Purpose: enhance generated test scaffolds into business-aware E2E tests.

Evidence:
- `packages/agent/src/orchestrate/test/orchestrateTest.ts`
  - builds scenarios, authorize/prep/generate helpers, then operation tests.
  - compiles the generated test suite.
- `website/src/content/docs/concepts/waterfall.mdx`
  - describes dependency-aware scenario generation and compiler-driven refinement.

### Realize
Purpose: write actual service/provider code against the prior artifacts.

Evidence:
- `packages/agent/src/orchestrate/realize/orchestrateRealize.ts`
  - writes reusable helpers and endpoint operations.
  - compiles realization output and generates controllers.
- `website/src/content/docs/concepts/waterfall.mdx`
  - says Realize uses both compilation feedback and runtime test feedback.

## 6. Compiler stack
AutoBE describes a three-tier compiler architecture:

1. Prisma compiler
2. OpenAPI / interface compiler
3. TypeScript compiler

### What each layer does
- Prisma compiler: validates/generates DB schema artifacts.
- Interface compiler: validates/transforms API AST into OpenAPI and NestJS.
- TypeScript compiler: checks final integration/buildability.

### Evidence
- `website/src/content/docs/concepts/compiler.mdx`
  - explicitly describes the three-tier stack.
- `packages/compiler/src/AutoBeCompiler.ts`
  - wires together `database`, `interface`, `typescript`, `test`, and `realize` compiler components.
- `packages/compiler/src/AutoBeTypeScriptCompiler.ts`
  - uses an in-memory TypeScript + ESLint-based compilation step as a final gate.

## 7. What the pipeline is optimized for
The system is optimized for:
- typed artifacts
- constrained generation
- deterministic code generation
- in-project compilation
- iterative repair

It is not fundamentally optimized for unconstrained creativity or arbitrary stack choice.

### Evidence
- `README.md`
  - tightly scopes the stack around TypeScript, Prisma, NestJS, SDKs, and E2E tests.
- `website/src/content/docs/concepts/compiler.mdx`
  - repeats the "structure first, validate continuously, generate deterministically" framing.

## 8. Essence of the architecture
The essence of AutoBE is:

- decompose the backend into stable intermediate forms,
- make the LLM generate those forms rather than code where possible,
- validate each form with compilers and custom rules,
- only then generate code,
- and keep repairing against compiler feedback.

That is the architectural reason AutoBE can plausibly outperform prompt-only backend generation systems on buildability.
