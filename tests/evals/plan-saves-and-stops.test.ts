// tests/evals/plan-saves-and-stops.test.ts
//
// Behavior eval: `/supi:plan` must write a plan file under
// `.omp/supipowers/plans/` AND the approval flow must stop forward progress
// at that point — surfacing the approval UI instead of silently continuing.
//
// How to break it (sanity check for reviewers):
//   - Remove the `await ctx.ui.select(...)` call in approval-flow.ts and
//     auto-advance to executeApproveFlow on new-plan detection → this eval
//     fails because `ctx.ui.select` call count never reaches 1.
//   - Have registerPlanApprovalHook fire select even when no new plan is
//     detected → the pre-write assertion fails (select called before any
//     plan was written).
//   - Drop `cancelPlanTracking()` before `executeApproveFlow` → the
//     post-approval assertion fails (isPlanningActive() stays true).
//
// Regression class: approval flow auto-continues past plan save without
// user confirmation, or prompts for approval when no plan has been saved.

import { expect } from "bun:test";
import { defineEval } from "./harness.js";
import { makeEvalPlatform, makeEvalContext, makeTempWorkspace } from "./fixtures.js";
import {
  registerPlanApprovalHook,
  startPlanTracking,
  cancelPlanTracking,
  isPlanningActive,
} from "../../src/planning/approval-flow.js";

defineEval({
  name: "plan-saves-and-stops",
  summary:
    "/supi:plan saves a plan under .omp/supipowers/plans/ and approval flow halts for user choice",
  regressionClass:
    "approval flow auto-continues past plan save without user confirmation, or prompts before any plan file exists",
  run: async () => {
    const workspace = makeTempWorkspace();
    try {
      const { platform, fireHook } = makeEvalPlatform({ cwd: workspace.dir });
      const ctx = makeEvalContext({ cwd: workspace.dir });

      // Approval flow only resolves further execution when the user selects
      // "Approve and execute". Resolving this way also exercises the stop
      // guarantee: cancelPlanTracking() must run before any handoff.
      ctx.ui.select.mockResolvedValue("Approve and execute");

      registerPlanApprovalHook(platform);
      startPlanTracking(workspace.dir, platform.paths);

      expect(isPlanningActive()).toBe(true);

      // --- Pre-plan fire --------------------------------------------------
      // No plan written yet. agent_end must NOT surface the approval UI,
      // or we'd be prompting users about plans that don't exist.
      await fireHook("agent_end", {}, ctx);
      expect(ctx.ui.select).toHaveBeenCalledTimes(0);
      expect(isPlanningActive()).toBe(true);

      // --- Plan saved -----------------------------------------------------
      workspace.writePlan(
        "2026-04-17-test.md",
        "# Test plan\n\nDo the thing.\n",
      );
      expect(workspace.listPlans()).toContain("2026-04-17-test.md");

      // --- Post-plan fire -------------------------------------------------
      // Exactly one approval prompt, and tracking is released so the next
      // step is the user's choice — not another silent agent turn.
      await fireHook("agent_end", {}, ctx);
      expect(ctx.ui.select).toHaveBeenCalledTimes(1);
      const [question, options] = ctx.ui.select.mock.calls[0];
      expect(typeof question).toBe("string");
      expect(options).toContain("Approve and execute");
      expect(options).toContain("Stay in plan mode");
      expect(isPlanningActive()).toBe(false);
    } finally {
      // Module-level state — reset so sibling evals aren't polluted.
      cancelPlanTracking();
      workspace.cleanup();
    }
  },
});
