import type { Profile, GateResult, ReviewReport } from "../types.js";
import { buildLspGatePrompt } from "./lsp-gate.js";
import { buildAiReviewPrompt } from "./ai-review-gate.js";
import { buildTestGatePrompt } from "./test-gate.js";

export interface GateRunnerOptions {
  profile: Profile;
  changedFiles: string[];
  testCommand: string | null;
  lspAvailable: boolean;
}

export function getActiveGates(profile: Profile, lspAvailable: boolean): string[] {
  const gates: string[] = [];
  if (profile.gates.lspDiagnostics && lspAvailable) gates.push("lsp-diagnostics");
  if (profile.gates.aiReview.enabled) gates.push("ai-review");
  if (profile.gates.codeQuality) gates.push("code-quality");
  if (profile.gates.testSuite) gates.push("test-suite");
  if (profile.gates.e2e) gates.push("e2e");
  return gates;
}

export function buildReviewPrompt(options: GateRunnerOptions): string {
  const { profile, changedFiles, testCommand, lspAvailable } = options;
  const sections: string[] = [
    "# Code Review",
    "",
    `Profile: ${profile.name}`,
    "",
    "Run the following quality checks and report results for each:",
    "",
  ];

  if (profile.gates.lspDiagnostics && lspAvailable) {
    sections.push("## 1. LSP Diagnostics", buildLspGatePrompt(changedFiles), "");
  }

  if (profile.gates.aiReview.enabled) {
    sections.push(
      "## 2. Code Review",
      buildAiReviewPrompt(changedFiles, profile.gates.aiReview.depth),
      ""
    );
  }

  if (profile.gates.testSuite) {
    sections.push(
      "## 3. Test Suite",
      buildTestGatePrompt(testCommand, false),
      ""
    );
  }

  return sections.join("\n");
}

export function createReviewReport(
  profile: string,
  gates: GateResult[]
): ReviewReport {
  return {
    profile,
    timestamp: new Date().toISOString(),
    gates,
    passed: gates.every((g) => g.passed),
  };
}
