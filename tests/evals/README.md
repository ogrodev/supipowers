# Behavior evals

Eval-style integration tests for supipowers workflows. These enforce end-to-end
invariants that unit tests cannot reliably catch: plan-mode must stop after
save, context-mode must reroute high-output tool calls, review must validate
findings before reporting, and so on.

## Running

```bash
# Run only the evals
bun run test:evals

# Run a single eval by ID
bun test tests/evals/ --test-name-pattern 'eval:plan-saves-and-stops'

# Evals are also picked up by the full test run
bun test tests/
```

Evals are regular bun tests. The only difference from unit tests is scope: an
eval exercises a workflow boundary that a unit test would miss.

## Convention

- File name: `tests/evals/<eval-id>.test.ts`
- One `defineEval({ ... })` call per file
- The eval's `name` must match the filename so
  `--test-name-pattern 'eval:<name>'` always resolves

## Writing a new eval

1. Pick an invariant the product must keep holding.
2. Describe its regression class in one sentence. Examples:
   - "plan command continues past save or never saves"
   - "context-mode silently stops enforcing ctx_\* tools"
   - "review emits findings before validation runs"
3. Import `defineEval` from `./harness.js` and mocks from `./fixtures.js`.
4. Drive the command/hook under test with the mock platform/context.
5. Assert the invariant explicitly.
6. Fail the assertion and re-run to confirm the eval fails on the intended
   regression class. If it passes when the invariant is broken, tighten the
   assertion.

## Scaffold

```ts
import { defineEval } from "./harness.js";
import { makeEvalPlatform, makeEvalContext, makeTempWorkspace } from "./fixtures.js";

defineEval({
  name: "my-new-invariant",
  summary: "short statement of what should always be true",
  regressionClass: "what this eval catches when it fails",
  run: async () => {
    const { platform, capturedHooks } = makeEvalPlatform();
    const workspace = makeTempWorkspace();
    try {
      // exercise the code under test
      // assert the invariant
    } finally {
      workspace.cleanup();
    }
  },
});
```

## Non-goals

- Do not make real LLM calls in evals. Evals must be deterministic and run
  offline.
- Do not duplicate existing unit-test coverage. If a unit test already proves
  the invariant, there is no need for an eval.
- Do not couple evals to prompt wording. Assert on tool calls, file writes,
  and runtime decisions — not on string content of prompts unless the prompt
  is the invariant (e.g., planning_ask vs ask).
