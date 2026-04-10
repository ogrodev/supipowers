import { describe, expect, test } from "bun:test";
import type { GateExecutionContext, GateIssue, LspDiagnosticsGateConfig } from "../../../src/types.js";
import { lspDiagnosticsGate } from "../../../src/quality/gates/lsp-diagnostics.js";

const enabledConfig: LspDiagnosticsGateConfig = { enabled: true };

function createContext(options?: {
  activeTools?: string[];
  diagnostics?: GateIssue[];
  diagnosticsError?: Error;
}): GateExecutionContext {
  return {
    cwd: "/tmp/project",
    changedFiles: ["src/example.ts"],
    scopeFiles: ["src/example.ts"],
    fileScope: "changed-files",
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    execShell: async () => ({ stdout: "", stderr: "", code: 0 }),
    getLspDiagnostics: async () => {
      if (options?.diagnosticsError) {
        throw options.diagnosticsError;
      }

      return options?.diagnostics ?? [];
    },
    createAgentSession: async () => ({
      subscribe: () => () => {},
      prompt: async () => {},
      state: { messages: [] },
      dispose: async () => {},
    }),
    activeTools: options?.activeTools ?? [],
    reviewModel: { model: "claude-opus-4-6", thinkingLevel: "high" },
  };
}

describe("lspDiagnosticsGate.detect", () => {
  test("recommends the gate when an LSP tool is active", () => {
    expect(
      lspDiagnosticsGate.detect({
        cwd: "/tmp/project",
        packageScripts: {},
        lockfiles: [],
        activeTools: ["typescript:lsp"],
        existingGates: {},
      }),
    ).toEqual({
      suggestedConfig: { enabled: true },
      confidence: "high",
      reason: "Active tools include LSP support.",
    });
  });
});

describe("lspDiagnosticsGate.run", () => {
  test("returns blocked when no LSP tool is active", async () => {
    let diagnosticsCalled = false;
    const context = createContext();
    context.getLspDiagnostics = async () => {
      diagnosticsCalled = true;
      return [];
    };

    const result = await lspDiagnosticsGate.run(context, enabledConfig);

    expect(result).toEqual({
      gate: "lsp-diagnostics",
      status: "blocked",
      summary: "LSP diagnostics gate blocked: no active LSP tool is available.",
      issues: [],
    });
    expect(diagnosticsCalled).toBe(false);
  });

  test("passes when diagnostics return no issues", async () => {
    const result = await lspDiagnosticsGate.run(
      createContext({ activeTools: ["lsp"], diagnostics: [] }),
      enabledConfig,
    );

    expect(result).toEqual({
      gate: "lsp-diagnostics",
      status: "passed",
      summary: "LSP diagnostics passed with no issues.",
      issues: [],
    });
  });

  test("fails when diagnostics include an error", async () => {
    const issues: GateIssue[] = [
      {
        severity: "warning",
        message: "Unused variable.",
        file: "src/example.ts",
        line: 4,
      },
      {
        severity: "error",
        message: "Cannot find name 'missingValue'.",
        file: "src/example.ts",
        line: 7,
      },
    ];

    const result = await lspDiagnosticsGate.run(
      createContext({ activeTools: ["typescript:lsp"], diagnostics: issues }),
      enabledConfig,
    );

    expect(result).toEqual({
      gate: "lsp-diagnostics",
      status: "failed",
      summary: "LSP diagnostics found 1 error(s) and 1 warning(s).",
      issues,
    });
  });

  test("returns blocked when diagnostics lookup throws", async () => {
    const result = await lspDiagnosticsGate.run(
      createContext({ activeTools: ["typescript:lsp"], diagnosticsError: new Error("server unavailable") }),
      enabledConfig,
    );

    expect(result).toEqual({
      gate: "lsp-diagnostics",
      status: "blocked",
      summary: "LSP diagnostics gate blocked: server unavailable",
      issues: [],
      metadata: { error: "server unavailable" },
    });
  });
});
