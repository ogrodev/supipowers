import { GATE_CONFIG_SCHEMAS } from "../registry.js";
import type {
  GateDefinition,
  GateExecutionContext,
  GateIssue,
  GateResult,
  LspDiagnosticsGateConfig,
  ProjectFacts,
} from "../../types.js";

function hasActiveLspTool(activeTools: string[]): boolean {
  return activeTools.some((tool) => tool.toLowerCase().split(":").includes("lsp"));
}

function summarizeDiagnostics(issues: GateIssue[]): string {
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;

  if (errorCount > 0) {
    return `LSP diagnostics found ${errorCount} error(s) and ${warningCount} warning(s).`;
  }

  if (warningCount > 0) {
    return `LSP diagnostics passed with ${warningCount} warning(s) and no errors.`;
  }

  return "LSP diagnostics passed with no issues.";
}

function detectLspDiagnosticsGate(projectFacts: ProjectFacts) {
  if (!hasActiveLspTool(projectFacts.activeTools)) {
    return null;
  }

  return {
    suggestedConfig: { enabled: true },
    confidence: "high" as const,
    reason: "Active tools include LSP support.",
  };
}

async function runLspDiagnosticsGate(
  context: GateExecutionContext,
  _config: LspDiagnosticsGateConfig,
): Promise<GateResult> {
  if (!hasActiveLspTool(context.activeTools)) {
    return {
      gate: "lsp-diagnostics",
      status: "blocked",
      summary: "LSP diagnostics gate blocked: no active LSP tool is available.",
      issues: [],
    };
  }

  try {
    const issues = await context.getLspDiagnostics(context.scopeFiles, context.fileScope);
    const hasErrors = issues.some((issue) => issue.severity === "error");

    return {
      gate: "lsp-diagnostics",
      status: hasErrors ? "failed" : "passed",
      summary: summarizeDiagnostics(issues),
      issues,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown diagnostics error";

    return {
      gate: "lsp-diagnostics",
      status: "blocked",
      summary: `LSP diagnostics gate blocked: ${message}`,
      issues: [],
      metadata: { error: message },
    };
  }
}

export const lspDiagnosticsGate: GateDefinition<LspDiagnosticsGateConfig> = {
  id: "lsp-diagnostics",
  description: "Runs LSP diagnostics across the current review scope.",
  configSchema: GATE_CONFIG_SCHEMAS["lsp-diagnostics"],
  detect: detectLspDiagnosticsGate,
  run: runLspDiagnosticsGate,
};
