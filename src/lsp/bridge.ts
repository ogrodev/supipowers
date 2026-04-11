// src/lsp/bridge.ts
import type { GateExecutionContext, GateIssue } from "../types.js";
import { runStructuredAgentSession } from "../quality/ai-session.js";
import { stripMarkdownCodeFence } from "../text.js";

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

function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    typeof value === "object" &&
    value !== null &&
    ["error", "warning", "info", "hint"].includes((value as Diagnostic).severity) &&
    typeof (value as Diagnostic).message === "string" &&
    typeof (value as Diagnostic).line === "number" &&
    typeof (value as Diagnostic).column === "number"
  );
}

function isDiagnosticsResult(value: unknown): value is DiagnosticsResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DiagnosticsResult).file === "string" &&
    Array.isArray((value as DiagnosticsResult).diagnostics) &&
    (value as DiagnosticsResult).diagnostics.every((diagnostic) => isDiagnostic(diagnostic))
  );
}

function normalizeDiagnosticSeverity(severity: Diagnostic["severity"]): GateIssue["severity"] {
  return severity === "hint" ? "info" : severity;
}

function formatDiagnosticDetail(diagnostic: Diagnostic): string | undefined {
  return diagnostic.column > 0 ? `column ${diagnostic.column}` : undefined;
}

function parseLspDiagnosticsResults(raw: string): DiagnosticsResult[] | null {
  try {
    const parsed = JSON.parse(stripMarkdownCodeFence(raw)) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => isDiagnosticsResult(entry)) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Request LSP diagnostics via a headless agent session that can call the lsp tool.
 */
export function buildLspDiagnosticsPrompt(
  scopeFiles: string[],
  fileScope: GateExecutionContext["fileScope"],
): string {
  const scopeInstruction =
    fileScope === "all-files"
      ? [
          'Run repository-wide diagnostics with the lsp tool using action "diagnostics" and file "*".',
          "Return diagnostics for files that report issues.",
        ]
      : [
          "Run LSP diagnostics on these files:",
          ...scopeFiles.map((file) => `- ${file}`),
          "",
          'Use the lsp tool with action "diagnostics" for each listed file.',
        ];

  return [
    "You are collecting structured LSP diagnostics for a review quality gate.",
    ...scopeInstruction,
    "",
    "Return JSON only as an array with this exact shape:",
    '[{"file":"path/to/file.ts","diagnostics":[{"severity":"error|warning|info|hint","message":"text","line":1,"column":1}]}]',
    "",
    "Rules:",
    "- Do not wrap the JSON in markdown fences.",
    "- Include line and column numbers exactly as reported by the tool.",
    "- Use an empty array when there are no diagnostics.",
  ].join("\n");
}

export async function collectLspDiagnostics(options: {
  cwd: string;
  scopeFiles: string[];
  fileScope: GateExecutionContext["fileScope"];
  createAgentSession: GateExecutionContext["createAgentSession"];
  reviewModel?: GateExecutionContext["reviewModel"];
}): Promise<GateIssue[]> {
  const sessionResult = await runStructuredAgentSession(options.createAgentSession, {
    cwd: options.cwd,
    prompt: buildLspDiagnosticsPrompt(options.scopeFiles, options.fileScope),
    model: options.reviewModel?.model,
    thinkingLevel: options.reviewModel?.thinkingLevel ?? null,
    timeoutMs: 120_000,
  });

  if (sessionResult.status !== "ok") {
    throw new Error(sessionResult.error);
  }

  const parsed = parseLspDiagnosticsResults(sessionResult.finalText);
  if (!parsed) {
    throw new Error("LSP diagnostics integration returned invalid JSON.");
  }

  return parsed.flatMap((result) =>
    result.diagnostics.map<GateIssue>((diagnostic) => ({
      severity: normalizeDiagnosticSeverity(diagnostic.severity),
      message: diagnostic.message,
      file: result.file,
      line: diagnostic.line,
      detail: formatDiagnosticDetail(diagnostic),
    })),
  );
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
