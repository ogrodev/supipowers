// Regression class:
//   "/supi:fix-pr marks work complete while unresolved comments for the
//    selected target remain"
//
// FIX-VIA: future P7-02 completion blocker work. At the time this eval
// was authored, src/commands/fix-pr.ts has NO completion-gate logic — the
// handler ends at `notifyInfo("Fix-PR started: ...")` and returns. There
// is no code path that refuses to mark work complete when the selected
// target still has unresolved comments. This eval is intentionally
// authored to fail today so it acts as a regression gate that flips to
// passing once the completion blocker lands. Per the task instructions,
// failing evals are valid regression gates in this repo — do NOT skip.
//
// Strategy: Approach B (structural). We assert the presence of a
// completion-gate branch in src/commands/fix-pr.ts. Concretely: somewhere
// in the handler there must be a notify/error/warn branch whose trigger
// is keyed on unresolved-comment state for the selected cluster, AND it
// must fire before any "work complete" / "session complete" notification.
//
// How to unbreak it (and pass this eval): add a completion-gate in
// src/commands/fix-pr.ts that inspects the selected cluster for
// unresolved comments (e.g., comments with no reply / no resolution
// marker from the bot reviewer) and, if any remain, emits a
// notifyWarning/notifyError like "Unresolved comments remain" before the
// handler allows a completion notification.

import { defineEval } from "./harness.js";
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

defineEval({
  name: "fix-pr-blocks-complete-with-unresolved-selected-comments",
  summary:
    "/supi:fix-pr has an explicit completion-gate that blocks marking work complete while unresolved comments remain for the selected target",
  regressionClass:
    "/supi:fix-pr marks work complete while unresolved comments for the selected target remain",
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

    // The completion-gate must reference the "unresolved" concept and
    // trigger a user-visible notify/warn/error branch. We accept any
    // spelling that pairs the unresolved concept with a notification
    // call — this lets the implementation pick the right wording while
    // still enforcing the invariant shape.
    const mentionsUnresolved = /\bunresolved\b/i.test(source);
    expect(mentionsUnresolved).toBe(true);

    // The gate must wire unresolved state into a notify branch. We look
    // for any notifyWarning / notifyError / notifyInfo call site that
    // contains the word "unresolved" in its argument block.
    const notifyWithUnresolved =
      /notify(?:Warning|Error|Info)\s*\(\s*ctx\s*,[\s\S]{0,400}?unresolved/i.test(
        source,
      );
    expect(notifyWithUnresolved).toBe(true);

    // If a "completed" / "complete" user-facing notification exists, it
    // must be preceded by the unresolved-comment check. We locate the
    // first "complete" notification (if any) and assert the unresolved
    // gate appears earlier in the file. When no completion notification
    // exists yet, the `notifyWithUnresolved` assertion above is the
    // primary guardrail.
    const completeMatch = source.match(
      /notify(?:Info|Warning)\s*\(\s*ctx\s*,\s*`Fix-PR\s+(?:complete|finished|done)/i,
    );
    if (completeMatch && completeMatch.index !== undefined) {
      const unresolvedIdx = source.toLowerCase().indexOf("unresolved");
      expect(unresolvedIdx).toBeGreaterThan(-1);
      expect(unresolvedIdx).toBeLessThan(completeMatch.index);
    }
  },
});
