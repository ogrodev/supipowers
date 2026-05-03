// src/lsp/bridge.ts
import type { GateExecutionContext, GateIssue } from "../types.js";
import { parseStructuredOutput, runWithOutputValidation, type ReliabilityReporter } from "../ai/structured-output.js";
import { renderSchemaText } from "../ai/schema-text.js";
import { appendReliabilityRecord } from "../storage/reliability-metrics.js";
import { probeLspCapabilities } from "./capabilities.js";
import {
  LspDiagnosticsResultsSchema,
  type LspDiagnostic,
  type LspDiagnosticsResults,
} from "./contracts.js";

const LSP_DIAGNOSTICS_SCHEMA_TEXT = renderSchemaText(LspDiagnosticsResultsSchema);

function normalizeDiagnosticSeverity(severity: LspDiagnostic["severity"]): GateIssue["severity"] {
  return severity === "hint" ? "info" : severity;
}

function formatDiagnosticDetail(diagnostic: LspDiagnostic): string | undefined {
  return diagnostic.column > 0 ? `column ${diagnostic.column}` : undefined;
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
    "Return JSON only matching this schema:",
    LSP_DIAGNOSTICS_SCHEMA_TEXT,
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
  reliability?: ReliabilityReporter;
}): Promise<GateIssue[]> {
  const caps = await probeLspCapabilities({
    cwd: options.cwd,
    createAgentSession: options.createAgentSession,
    reviewModel: options.reviewModel,
    reliability: options.reliability,
  });
  if (!caps.diagnostics) {
    // Active LSP server is registered but advertises no
    // textDocument/diagnostic support — fail the gate cleanly with an
    // empty issue list rather than throwing on a vacuous probe error.
    // Emit a single reliability record so /supi:doctor surfaces the skip.
    if (options.reliability) {
      try {
        appendReliabilityRecord(options.reliability.paths, options.reliability.cwd, {
          ts: new Date().toISOString(),
          command: options.reliability.command,
          operation: options.reliability.operation,
          outcome: "fallback",
          attempts: 0,
          reason: "lsp-server-lacks-diagnostics",
          cwd: options.reliability.cwd,
        });
      } catch {
        // appendReliabilityRecord already swallows its own errors; this
        // try/catch is belt-and-braces in case the helper itself throws.
      }
    }
    return [];
  }

  const result = await runWithOutputValidation<LspDiagnosticsResults>(options.createAgentSession, {
    cwd: options.cwd,
    prompt: buildLspDiagnosticsPrompt(options.scopeFiles, options.fileScope),
    schema: LSP_DIAGNOSTICS_SCHEMA_TEXT,
    parse: (raw) => parseStructuredOutput<LspDiagnosticsResults>(raw, LspDiagnosticsResultsSchema),
    model: options.reviewModel?.model,
    thinkingLevel: options.reviewModel?.thinkingLevel ?? null,
    timeoutMs: 120_000,
    reliability: options.reliability,
  });

  if (result.status === "blocked") {
    throw new Error(`LSP diagnostics integration failed: ${result.error}`);
  }

  return result.output.flatMap((entry) =>
    entry.diagnostics.map<GateIssue>((diagnostic) => ({
      severity: normalizeDiagnosticSeverity(diagnostic.severity),
      message: diagnostic.message,
      file: entry.file,
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
