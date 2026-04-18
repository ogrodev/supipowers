# ForgeCode-inspired improvement plan for supipowers

This folder turns the ForgeCode research into a concrete improvement roadmap for supipowers.

The main lesson is not “copy ForgeCode.” The lesson is: improve supipowers as a reliability harness.

Supipowers already has the right architectural base:
- OMP-native orchestration and command interception in `src/bootstrap.ts`
- planning-mode prompt control and approval handoff in `src/planning/system-prompt.ts` and `src/planning/approval-flow.ts`
- context-window routing, compression, and knowledge tools in `src/context-mode/hooks.ts` and `src/context-mode/tools.ts`
- multi-agent review, validation, consolidation, and fix loops in `src/commands/ai-review.ts` and `src/review/multi-agent-runner.ts`
- deterministic quality gates in `src/quality/runner.ts`

So this plan is additive. It sharpens existing strengths instead of rewriting the product around a different runtime.

## Principles carried over from the ForgeCode research

1. Prefer runtime enforcement over prompt-only suggestions.
2. Treat agent failures as regressions that deserve dedicated tests.
3. Invest in entry-point discovery, not just more context.
4. Make tool usage easier to do correctly than incorrectly.
5. Use stored session data to drive the next round of hardening.

## Anti-goals

- Do not rebuild supipowers as a standalone terminal agent. It should stay OMP-native.
- Do not depend on a proprietary hosted retrieval/runtime layer.
- Do not adopt benchmark-gaming patterns like broad implicit instruction injection.
- Do not add parallelism everywhere; use it only where the workflow benefits and remains understandable.

## Recommended chunk order

| Chunk | Focus | Why first / next | Primary test gate |
| --- | --- | --- | --- |
| 01 | Behavior eval harness | Creates the measurement system the other chunks depend on | `bun test tests/evals/` passes with deterministic fixtures |
| 02 | Runtime guardrails | Converts workflow invariants into enforced behavior | workflow integration tests + evals catch premature completion |
| 03 | Discovery and retrieval | Improves repo entry-point discovery for plan/review/QA/fix flows | fixture workspaces rank expected files/symbols first |
| 04 | Tool contracts and prompts | Reduces tool-call ambiguity and prompt bloat | schema/prompt tests + evals show improved tool selection |
| 05 | Telemetry and failure mining | Closes the loop from real failures to new evals | offline analysis tests classify fixture sessions correctly |
| 06 | QA and fix-pr rollout | Applies proven patterns to more workflows | command-level tests for `/supi:qa` and `/supi:fix-pr` pass with new guardrails |

## Parallelization guidance

Default order should be:
- 01 first
- 02 and 04 next
- 03 after 01, before broad workflow rollout
- 05 after the first new instrumentation lands
- 06 last, once the shared pieces are stable

The only chunk that should start immediately and unconditionally is chunk 01. Everything else is more valuable once there is a behavior-level regression harness to measure it.

## Document map

- `01-behavior-eval-harness.md`
- `02-runtime-guardrails.md`
- `03-discovery-and-retrieval.md`
- `04-tool-contracts-and-prompts.md`
- `05-telemetry-and-failure-mining.md`
- `06-qa-and-fix-pr-rollout.md`

## Definition of success for the overall plan

Supipowers should be meaningfully better when all chunks are complete if these statements become true:
- workflow regressions are caught by behavior evals, not only by unit tests
- plan/review/QA/fix workflows are harder to complete incorrectly
- the agent reaches the right files faster on larger repos
- tool misuse drops because tool contracts are simpler and prompts are tighter
- stored sessions and debug traces routinely produce new hardening work
- QA and fix-pr reuse the same guardrails and discovery improvements instead of drifting into separate orchestration styles
