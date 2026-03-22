// src/lsp/bridge.ts

export interface DiagnosticsResult {
  file: string;
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  line: number;
  column: number;
}

/**
 * Request LSP diagnostics for a file by sending a message that
 * triggers the LLM to use the lsp tool. For direct use,
 * we provide a prompt snippet the orchestrator can include
 * in sub-agent assignments.
 */
export function buildLspDiagnosticsPrompt(files: string[]): string {
  const fileList = files.map((f) => `- ${f}`).join("\n");
  return [
    "Run LSP diagnostics on these files and report any errors or warnings:",
    fileList,
    "",
    'Use the lsp tool with action "diagnostics" for each file.',
    "Report the results in this format:",
    "FILE: <path>",
    "  LINE:COL SEVERITY: message",
  ].join("\n");
}

/**
 * Build a prompt snippet for sub-agents to check references before renaming.
 */
export function buildLspReferencesPrompt(symbol: string, file: string): string {
  return [
    `Before modifying "${symbol}" in ${file}, use the lsp tool:`,
    `1. action: "references", file: "${file}", symbol: "${symbol}"`,
    "2. Review all references to understand impact",
    "3. Update all references as part of your changes",
  ].join("\n");
}

/**
 * Build a prompt for post-edit validation via LSP.
 */
export function buildLspValidationPrompt(files: string[]): string {
  const fileList = files.map((f) => `- ${f}`).join("\n");
  return [
    "After making your changes, validate with LSP:",
    fileList,
    "",
    'Use the lsp tool with action "diagnostics" on each changed file.',
    "If there are errors, fix them before reporting completion.",
  ].join("\n");
}
