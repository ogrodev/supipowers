// Regression class:
//   "review pipeline emits findings.md without running validator first."
//
// Strategy: Approach B (structural). Approach A would require driving
// runAiReviewSessionForTest with mocks for selectReviewTarget,
// selectReviewLevel, selectReviewResultsAction, selectYesNo,
// selectMaxIterations, discoverWorkspaceTargets, and the agent session
// transport — none of which are exposed via AiReviewCommandDependencies.
// Reproducing that orchestration faithfully would dwarf the actual
// invariant we care about (>100 lines of glue), so we assert the
// invariant structurally on the source file instead.
//
// Invariant: in src/commands/ai-review.ts, the first call site of
// deps.validateReviewFindings(...) precedes the first invocation of
// writeFindingsReport(...) — the only helper that writes
// FINDINGS_REPORT_FILE ("findings.md"). This catches a refactor that
// reorders the pipeline so the report is materialized from raw,
// unvalidated findings.
//
// How to break it: in src/commands/ai-review.ts, move the
// `writeFindingsReport(...)` call at L1053 above the
// `await deps.validateReviewFindings({...})` block at L1005, or delete
// the validate call entirely. Either change makes the index check fail.

import { defineEval } from "./harness.js";
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

defineEval({
  name: "review-validates-before-report",
  summary:
    "/supi:review runs validateReviewFindings on raw findings before writing findings.md",
  regressionClass:
    "review pipeline emits findings.md without running validator first",
  run: () => {
    const sourcePath = path.resolve(
      __dirname,
      "..",
      "..",
      "src",
      "commands",
      "ai-review.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf8");

    // Sanity: the constants and dependency wiring we rely on still exist.
    // If any of these vanish, the invariant has shifted shape and the eval
    // must be revisited rather than silently passing on a stale check.
    expect(source).toContain('const FINDINGS_REPORT_FILE = "findings.md"');
    expect(source).toContain(
      'import { validateReviewFindings } from "../review/validator.js"',
    );
    expect(source).toContain("writeReviewArtifact,");

    // Find every call site of deps.validateReviewFindings(...). The dep
    // type declaration uses `validateReviewFindings: typeof ...` (no
    // open paren after the name), so the `deps.` prefix isolates real
    // call sites from the type/import noise.
    const validateCallSites: number[] = [];
    {
      const re = /deps\.validateReviewFindings\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        validateCallSites.push(m.index);
      }
    }
    expect(validateCallSites.length).toBeGreaterThan(0);

    // Find every CALL site of writeFindingsReport(...). Exclude the
    // function declaration line itself.
    const reportCallSites: number[] = [];
    {
      const re = /(^|[^a-zA-Z_])writeFindingsReport\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        // Skip the declaration: `function writeFindingsReport(`.
        const start = Math.max(0, m.index - "function ".length);
        const window = source.slice(start, m.index + "writeFindingsReport(".length);
        if (window.includes("function writeFindingsReport")) continue;
        reportCallSites.push(m.index);
      }
    }
    expect(reportCallSites.length).toBeGreaterThan(0);

    // Confirm writeFindingsReport is the only path that emits
    // FINDINGS_REPORT_FILE — otherwise the structural ordering check
    // doesn't cover all emission sites. The helper body should be the
    // single textual pairing of `deps.writeReviewArtifact(` with the
    // FINDINGS_REPORT_FILE constant.
    const reportEmissions = source.match(
      /deps\.writeReviewArtifact\([\s\S]*?FINDINGS_REPORT_FILE/g,
    );
    expect(reportEmissions).not.toBeNull();
    expect(reportEmissions!.length).toBe(1);

    // Core invariant: validation happens before the first report write.
    const firstValidate = validateCallSites[0];
    const firstReport = reportCallSites[0];
    expect(firstValidate).toBeLessThan(firstReport);
  },
});
