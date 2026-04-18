// Regression class: review fix-now path silently completes without rerunning
// the review after fixes are applied.
//
// Approach B (structural source check). Approach A (spy on module-level
// runners and drive the handler) was rejected: `handleAiReview` is deeply
// TUI-driven (selectReviewScope, selectYesNo, selectMaxIterations, progress
// widgets, agent-session plumbing) and reconstructing a minimal driver that
// reaches the rerun branch without re-implementing half of ai-review.ts is
// more brittle than a structural assertion against the source of truth.
//
// What we assert: inside src/commands/ai-review.ts, within the `fix-now`
// handling region, after `runAutoFix` is invoked, the rerun loop calls a
// review runner again (via `runReviewPass`, which itself fans out to
// `runQuickReview` / `runDeepReview`). If someone deletes the rerun branch
// or short-circuits past it, this eval fails.
//
// How to break it: delete the `if (reviewLoop)` block in ai-review.ts, or
// replace the `runReviewPass(...)` call inside it with a no-op / early
// return. Either mutation makes the structural check fail.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import { defineEval } from "./harness.js";

defineEval({
  name: "review-rerun-loop",
  summary:
    "After /supi:review fix-now applies fixes, the rerun branch invokes the review runner again instead of silently completing.",
  regressionClass:
    "review fix-now path silently completes without rerunning the review after fixes are applied.",
  run: () => {
    const source = readFileSync(
      join(process.cwd(), "src/commands/ai-review.ts"),
      "utf8",
    );

    // Sanity: the `fix-now` action constant still exists. If the action is
    // renamed the structural anchors below are meaningless.
    expect(source).toContain('value: "fix-now"');

    // Locate the initial fix invocation inside the fix-now handler. This
    // anchors the start of the "after fixes applied" region.
    const initialFixIdx = source.indexOf("const initialFix = await deps.runAutoFix");
    expect(initialFixIdx).toBeGreaterThan(-1);

    // Locate the rerun branch guard. Must appear after the initial fix.
    const reviewLoopIdx = source.indexOf("if (reviewLoop)", initialFixIdx);
    expect(reviewLoopIdx).toBeGreaterThan(initialFixIdx);

    // The rerun branch must call back into a review runner. `runReviewPass`
    // is the internal helper that dispatches to runQuickReview / runDeepReview.
    const rerunCallIdx = source.indexOf("runReviewPass(", reviewLoopIdx);
    expect(rerunCallIdx).toBeGreaterThan(reviewLoopIdx);

    // And it must be inside a loop so subsequent iterations are reachable,
    // not a single-shot call that completes silently after one pass.
    const forLoopIdx = source.indexOf("for (let iteration", reviewLoopIdx);
    expect(forLoopIdx).toBeGreaterThan(reviewLoopIdx);
    expect(forLoopIdx).toBeLessThan(rerunCallIdx);

    // Defense in depth: the rerun call must precede any subsequent runAutoFix
    // in the loop (i.e. we re-review BEFORE we apply more fixes), proving the
    // "rerun after fixes" ordering is preserved.
    const loopFixIdx = source.indexOf("deps.runAutoFix", rerunCallIdx);
    expect(loopFixIdx).toBeGreaterThan(rerunCallIdx);

    // `runReviewPass` must itself dispatch to a real runner so the assertion
    // above has teeth.
    expect(source).toMatch(/runQuickReview|runDeepReview/);
  },
});
