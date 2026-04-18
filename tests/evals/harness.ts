// tests/evals/harness.ts
//
// Behavior eval harness built on bun:test.
//
// Unit tests prove individual helpers work. Behavior evals prove end-to-end
// workflow invariants hold. Examples of invariants these evals catch:
//   - /supi:plan must save a plan file and stop, not continue past save
//   - planning mode must use the planning_ask tool, never the default ask tool
//   - context-mode must reroute high-output tool calls to ctx_* tools
//   - /supi:review must validate findings before emitting the final report
//   - review must rerun the loop after fixes when requested
//
// Evals live under `tests/evals/` and run via `bun run test:evals`. They are
// also included in `bun test tests/` because they are real bun tests — the
// only difference is scope: a regression that only shows up at workflow
// boundaries fails here, not in the narrow unit-test subtrees.

import { describe, test } from "bun:test";

export interface EvalDefinition {
  /**
   * Eval ID, e.g. `plan-saves-and-stops`.
   * Appears in `test:evals --test-name-pattern <name>` filters.
   */
  name: string;

  /** One-line summary describing the invariant under test. */
  summary: string;

  /**
   * Short description of the regression class this eval exists to catch.
   * Keep it specific enough that a reader can reconstruct why the eval was added.
   */
  regressionClass: string;

  /** Eval body. Throw (or fail an expect) to mark the invariant broken. */
  run: () => Promise<void> | void;
}

/**
 * Register a behavior eval. Wraps `describe`/`test` with a consistent naming
 * convention so `--test-name-pattern eval:<name>` filters a single eval.
 *
 * Usage:
 *   defineEval({
 *     name: "plan-saves-and-stops",
 *     summary: "/supi:plan writes a plan under .omp/supipowers/plans/ and stops",
 *     regressionClass: "plan command continues past save or never saves",
 *     run: async () => { ... },
 *   });
 */
export function defineEval(def: EvalDefinition): void {
  describe(`eval:${def.name}`, () => {
    test(def.summary, async () => {
      await def.run();
    });
  });
}
