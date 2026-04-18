// Regression class:
//   "/supi:qa builds the orchestrator prompt before persisting a session,
//    risking context drift"
//
// How to break it: reorder src/commands/qa.ts so that
// `buildE2eOrchestratorPrompt({ ... })` executes before
// `deps.createNewE2eSession(...)`. The prompt embeds `sessionDir`, which
// is derived from the ledger returned by `createNewE2eSession` — building
// the prompt first either forces a placeholder sessionDir or drifts the
// agent into a prompt that does not match the session actually persisted.
//
// Strategy: Approach B (structural). Same pattern as
// review-validates-before-report: the handler is TUI-heavy, so we assert
// the code order on the source file of truth.

import { defineEval } from "./harness.js";
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

defineEval({
  name: "qa-creates-session-and-prompt-context",
  summary:
    "/supi:qa calls createNewE2eSession before buildE2eOrchestratorPrompt so the prompt embeds a real session directory",
  regressionClass:
    "/supi:qa builds the orchestrator prompt before persisting a session, risking context drift",
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

    // Sanity: both helpers are still wired through the dependency bag
    // and the prompt builder import is present. If these shift, the
    // invariant moved and this eval must be rewritten.
    expect(source).toContain(
      'import { buildE2eOrchestratorPrompt } from "../qa/prompt-builder.js"',
    );
    expect(source).toContain(
      'import { createNewE2eSession } from "../qa/session.js"',
    );

    // Find the first CALL site (not the import / type alias / dep-bag
    // entry) of each helper. `deps.createNewE2eSession(` and
    // `buildE2eOrchestratorPrompt(` are the unambiguous invocation shapes.
    const sessionCallIdx = source.indexOf("deps.createNewE2eSession(");
    expect(sessionCallIdx).toBeGreaterThan(-1);

    // buildE2eOrchestratorPrompt is imported and then called as a bare
    // identifier; match `buildE2eOrchestratorPrompt(` but exclude the
    // import line (which has `import { buildE2eOrchestratorPrompt }`).
    const promptCallMatches: number[] = [];
    const re = /(^|[^a-zA-Z_])buildE2eOrchestratorPrompt\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      promptCallMatches.push(m.index);
    }
    expect(promptCallMatches.length).toBeGreaterThan(0);
    const firstPromptIdx = promptCallMatches[0];

    // Core invariant: session is persisted before the prompt is built.
    expect(sessionCallIdx).toBeLessThan(firstPromptIdx);

    // Defense in depth: the prompt builder call must receive `sessionDir`,
    // which is derived from the ledger returned by createNewE2eSession.
    // If the wiring changes, the ordering guarantee no longer implies
    // that the prompt carries a real session directory.
    const promptBlock = source.slice(
      firstPromptIdx,
      firstPromptIdx + 600,
    );
    expect(promptBlock).toContain("sessionDir");
  },
});
