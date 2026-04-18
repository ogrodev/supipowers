// Regression class:
//   "/supi:qa reports readiness when session or config artifacts are absent"
//
// How to break it: delete one of the early-return branches in
// src/commands/qa.ts that guard on a missing E2E QA config or an absent
// active session, or let `deps.notifyInfo("E2E QA started", ...)` run
// unconditionally at the tail of handleQa. Either mutation removes the
// guardrail that prevents /supi:qa from announcing success without the
// prerequisite persisted artifacts.
//
// Strategy: Approach B (structural). handleQa is a ~400-line TUI
// orchestrator that pulls in workspace discovery, wizard prompts, route
// discovery, and agent session plumbing. Driving it end-to-end to observe
// the readiness notification would require ~200 lines of mocks that do
// not pay for themselves. We assert on the source instead: the success
// notification must be gated on both `loadE2eQaConfig` and
// `findActiveSession` having been consulted, with early-return blockers
// in between.

import { defineEval } from "./harness.js";
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

defineEval({
  name: "qa-refuses-premature-complete",
  summary:
    "/supi:qa never announces readiness without first consulting loadE2eQaConfig + findActiveSession and providing early-return blockers",
  regressionClass:
    "/supi:qa reports readiness when session or config artifacts are absent",
  run: () => {
    const sourcePath = path.resolve(
      __dirname,
      "..",
      "..",
      "src",
      "commands",
      "qa.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf8");

    // Sanity: both prerequisite helpers are wired into the dep bag.
    expect(source).toMatch(/loadE2eQaConfig:\s*typeof loadE2eQaConfig/);
    expect(source).toMatch(/findActiveSession:\s*typeof findActiveSession/);

    // Find the success notification. This is the single "E2E QA started"
    // notifyInfo call that announces readiness to the user.
    const successMatch = source.match(
      /deps\.notifyInfo\s*\(\s*ctx\s*,\s*`E2E QA started:/,
    );
    expect(successMatch).not.toBeNull();
    const successIdx = successMatch!.index!;

    // Both prerequisite calls must appear, and they must appear before the
    // success notification. If the handler announces readiness without
    // first loading config or probing the active session, the ordering
    // check below fails.
    const loadConfigIdx = source.indexOf("deps.loadE2eQaConfig(");
    const findSessionIdx = source.indexOf("deps.findActiveSession(");
    expect(loadConfigIdx).toBeGreaterThan(-1);
    expect(findSessionIdx).toBeGreaterThan(-1);
    expect(loadConfigIdx).toBeLessThan(successIdx);
    expect(findSessionIdx).toBeLessThan(successIdx);

    // There must be an early-return blocker keyed on config being absent
    // between loading config and the success notification. Matches both
    // `if (!config) return;` and multi-line `if (!config) { ... return ...; }`.
    const configGateRegion = source.slice(loadConfigIdx, successIdx);
    const configGate = /if\s*\(\s*!\s*config\b[\s\S]{0,200}?\breturn\b/.test(
      configGateRegion,
    );
    expect(configGate).toBe(true);

    // notifyError early-return blockers must exist in the handler path —
    // these cover the "target missing / not runnable" branches that also
    // refuse to announce readiness prematurely.
    const notifyErrorCalls = source.match(/deps\.notifyError\s*\(/g) ?? [];
    expect(notifyErrorCalls.length).toBeGreaterThanOrEqual(3);
  },
});
