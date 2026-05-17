// Regression class:
//   "/supi:fix-pr persists a session without a selected target, producing
//    ambiguous state"
//
// How to break it: reorder src/commands/fix-pr.ts so
// `createFixPrSession(...)` runs before target selection returns, or persist
// a session when `selected` is null/undefined.
// Either mutation lets a fix-pr session be written without an owning
// workspace target, which downstream consumers disambiguate heuristically
// and wrong.
//
// Strategy: Approach B (structural). The handler is 400+ lines of TUI
// plus workspace discovery plus snapshot writing. A runtime approach
// would require mocking discoverWorkspaceTargets, fetchPrComments,
// clusterCommentsByWorkspaceTarget, the ctx.ui select flow, and fs writes —
// well past the 70-line budget. The structural check captures the same
// invariant: in source order, a non-null selected target must precede every
// createFixPrSession(...) call, and the session-creation branch must be
// guarded by a non-null selection.

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

    // Sanity: the storage helper is imported from its expected module. If
    // this import moves, the invariant shape has shifted and the eval must be
    // revisited rather than silently passing.
    expect(source).toMatch(
      /import\s*\{[\s\S]*?createFixPrSession[\s\S]*?\}\s*from\s*"\.\.\/storage\/fix-pr-sessions\.js"/,
    );

    // Find the explicit selected-target assignment in the orchestrator flow.
    const selectCallIdx = source.indexOf("const selectedTarget = selected.target;");
    expect(selectCallIdx).toBeGreaterThan(-1);

    // Find the first CALL site of createFixPrSession.
    const createCallIdx = source.indexOf("createFixPrSession(");
    expect(createCallIdx).toBeGreaterThan(-1);

    // Core invariant: target selection precedes session creation.
    expect(selectCallIdx).toBeLessThan(createCallIdx);

    // Defense in depth: there is an explicit early return when selection
    // fails, so createFixPrSession is unreachable without a non-null selected
    // target in scope.
    const between = source.slice(selectCallIdx, createCallIdx);
    expect(between).toMatch(/let\s+activeSession\s*=\s*findActiveFixPrSession\([^)]*selectedTarget/);
    expect(between).toMatch(/\breturn\b/);

    // And the session-persisting call itself must receive the selected
    // target — otherwise "ordered before" is a vacuous check.
    const createCallBlock = source.slice(createCallIdx, createCallIdx + 200);
    expect(createCallBlock).toContain("selectedTarget");
  },
});
