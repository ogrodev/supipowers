import type { GateResult } from "../types.js";

export function buildLspGatePrompt(changedFiles: string[]): string {
  return [
    "Run LSP diagnostics on these files and report results:",
    ...changedFiles.map((f) => `- ${f}`),
    "",
    'Use the lsp tool with action "diagnostics" for each file.',
    "Summarize: total errors, total warnings, and list each issue.",
  ].join("\n");
}

export function createLspGateResult(
  hasErrors: boolean,
  errorCount: number,
  warningCount: number,
  issues: { severity: "error" | "warning" | "info"; message: string; file?: string; line?: number }[]
): GateResult {
  return {
    gate: "lsp-diagnostics",
    passed: !hasErrors,
    issues,
  };
}
