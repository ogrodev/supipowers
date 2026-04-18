// Regression class:
//   "/supi:fix-pr persists a session without a selected target, producing
//    ambiguous state"
//
// How to break it: reorder src/commands/fix-pr.ts so
// `createFixPrSession(...)` runs before `selectWorkspaceTarget(...)`
// returns, or persist a session when `selectedTarget` is null/undefined.
// Either mutation lets a fix-pr session be written without an owning
// workspace target, which downstream consumers disambiguate heuristically
// and wrong.
//
// Strategy: Approach B (structural). The handler is 400+ lines of TUI
// plus workspace discovery plus snapshot writing. A runtime approach
// would require mocking discoverWorkspaceTargets, fetchPrComments,
// clusterCommentsByWorkspaceTarget, selectWorkspaceTarget, the ctx.ui
// select flow, and fs writes — well past the 70-line budget. The
// structural check captures the same invariant: in source order,
// selectWorkspaceTarget(ctx, ...) must precede every
// createFixPrSession(...) call, and the session-creation branch must be
// guarded by a non-null selectedTarget.

import { defineEval } from "./harness.js";
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

defineEval({
  name: "fix-pr-selects-target-and-persists-session",
  summary:
    "/supi:fix-pr selects a workspace target before persisting a fix-pr session, so the session is never orphaned",
  regressionClass:
    "/supi:fix-pr persists a session without a selected target, producing ambiguous state",
  run: () => {
    const sourcePath = path.resolve(
      __dirname,
      "..",
      "..",
      "src",
      "commands",
      "fix-pr.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf8");

    // Sanity: both helpers are imported from their expected modules. If
    // these imports move, the invariant shape has shifted and the eval
    // must be revisited rather than silently passing.
    expect(source).toMatch(
      /import\s*\{[^}]*selectWorkspaceTarget[^}]*\}\s*from\s*"\.\.\/workspace\/selector\.js"/,
    );
    expect(source).toMatch(
      /import\s*\{[\s\S]*?createFixPrSession[\s\S]*?\}\s*from\s*"\.\.\/storage\/fix-pr-sessions\.js"/,
    );

    // Find the first CALL site of selectWorkspaceTarget that takes `ctx`
    // as its first argument — this is the real orchestrator-level
    // selection, distinct from the import / dep-type noise.
    const selectCallIdx = source.indexOf("selectWorkspaceTarget(ctx,");
    expect(selectCallIdx).toBeGreaterThan(-1);

    // Find the first CALL site of createFixPrSession.
    const createCallIdx = source.indexOf("createFixPrSession(");
    expect(createCallIdx).toBeGreaterThan(-1);

    // Core invariant: target selection precedes session creation.
    expect(selectCallIdx).toBeLessThan(createCallIdx);

    // Defense in depth: there is an explicit early return when the user
    // cancels target selection, so createFixPrSession is unreachable
    // without a non-null selectedTarget in scope.
    const between = source.slice(selectCallIdx, createCallIdx);
    expect(between).toMatch(/if\s*\(\s*!\s*selectedTarget\s*\)/);
    expect(between).toMatch(/\breturn\b/);

    // And the session-persisting call itself must receive the selected
    // target — otherwise "ordered before" is a vacuous check.
    const createCallBlock = source.slice(createCallIdx, createCallIdx + 200);
    expect(createCallBlock).toContain("selectedTarget");
  },
});
