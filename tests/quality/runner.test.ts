import { describe, expect, mock, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { runQualityGates } from "../../src/quality/runner.js";
import { lspDiagnosticsGate } from "../../src/quality/gates/lsp-diagnostics.js";
import type { AgentSession, ExecResult, Platform } from "../../src/platform/types.js";
import type { GateDefinition, GateId, GateResult, ResolvedModel } from "../../src/types.js";

const defaultReviewModel: ResolvedModel = {
  model: "claude-opus-4-6",
  thinkingLevel: "high",
  source: "action",
};

function createAgentSession(): AgentSession {
  return {
    subscribe: () => () => {},
    prompt: async () => {},
    state: { messages: [] },
    dispose: async () => {},
  };
}

function createAgentSessionWithText(finalText: string): AgentSession {
  return {
    subscribe: () => () => {},
    prompt: async () => {},
    state: { messages: [{ role: "assistant", content: finalText }] },
    dispose: async () => {},
  };
}

function createPlatformWithLspSession(options?: {
  changedFiles?: string[];
  activeTools?: string[];
  finalAssistantText?: string;
}): Pick<Platform, "exec" | "getActiveTools" | "createAgentSession"> {
  return {
    ...createPlatform(options?.changedFiles ?? ["src/review.ts"]),
    getActiveTools: () => options?.activeTools ?? ["lsp"],
    createAgentSession: async () =>
      createAgentSessionWithText(
        options?.finalAssistantText ??
          JSON.stringify([
            {
              file: "src/review.ts",
              diagnostics: [
                { severity: "warning", message: "Unused value", line: 4, column: 2 },
              ],
            },
          ]),
      ),
  };
}

function createPlatform(changedFiles = ["src/review.ts"]): Pick<Platform, "exec" | "getActiveTools" | "createAgentSession"> {
  return {
    exec: async (_cmd: string, args: string[]): Promise<ExecResult> => {
      const signature = args.join(" ");
      if (signature === "diff --name-only HEAD") {
        return { stdout: `${changedFiles.join("\n")}\n`, stderr: "", code: 0 };
      }
      if (signature === "diff --name-only --cached") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (signature === "ls-files --others --exclude-standard") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (signature === "ls-files") {
        return { stdout: `${changedFiles.join("\n")}\n`, stderr: "", code: 0 };
      }
      throw new Error(`Unexpected exec call: ${signature}`);
    },
    getActiveTools: () => [],
    createAgentSession: async () => createAgentSession(),
  };
}

function createGate(gate: GateId, status: GateResult["status"] = "passed"): GateDefinition<any> {
  return {
    id: gate,
    description: `Gate ${gate}`,
    configSchema: Type.Any(),
    detect: () => null,
    run: async () => ({
      gate,
      status,
      summary: `${gate}: ${status}`,
      issues: [],
    }),
  };
}

describe("runQualityGates", () => {
  test("applies canonical gate order and aggregates report", async () => {
    const report = await runQualityGates({
      platform: createPlatform(),
      cwd: "/tmp/project",
      gates: {
        "lint": { enabled: true, command: "eslint ." },
        "lsp-diagnostics": { enabled: true },
      },
      filters: {},
      reviewModel: defaultReviewModel,
      gateRegistry: {
        "lsp-diagnostics": createGate("lsp-diagnostics"),
        "lint": createGate("lint"),
      },
      now: () => new Date("2026-04-10T00:00:00.000Z"),
    });

    expect(report.selectedGates).toEqual(["lsp-diagnostics", "lint"]);
    expect(report.summary).toEqual({ passed: 2, failed: 0, skipped: 0, blocked: 0 });
    expect(report.overallStatus).toBe("passed");
  });

  test("records skipped gates and omits disabled gates", async () => {
    const report = await runQualityGates({
      platform: createPlatform(),
      cwd: "/tmp/project",
      gates: {
        "lsp-diagnostics": { enabled: true },
        "lint": { enabled: true, command: "eslint ." },
        "test-suite": { enabled: false, command: null },
      },
      filters: { skip: ["lint"] },
      reviewModel: { model: "claude-opus-4-6", thinkingLevel: null, source: "action" },
      gateRegistry: {
        "lsp-diagnostics": createGate("lsp-diagnostics"),
        "lint": createGate("lint"),
        "test-suite": createGate("test-suite"),
      },
    });

    expect(report.gates.find((gate) => gate.gate === "lint")?.status).toBe("skipped");
    expect(report.gates.find((gate) => gate.gate === "test-suite")).toBeUndefined();
    expect(report.summary).toEqual({ passed: 1, failed: 0, skipped: 1, blocked: 0 });
  });

  test("emits progress events for scope discovery and gate lifecycle", async () => {
    const onEvent = mock();
    const report = await runQualityGates({
      platform: createPlatform(["src/review.ts", "src/quality.ts"]),
      cwd: "/tmp/project",
      gates: {
        "lsp-diagnostics": { enabled: true },
        "lint": { enabled: true, command: "eslint ." },
      },
      filters: { skip: ["lint"] },
      reviewModel: defaultReviewModel,
      gateRegistry: {
        "lsp-diagnostics": createGate("lsp-diagnostics"),
        "lint": createGate("lint"),
      },
      onEvent,
    });

    expect(report.summary).toEqual({ passed: 1, failed: 0, skipped: 1, blocked: 0 });
    expect(onEvent.mock.calls).toEqual([
      [{ type: "scope-discovered", changedFiles: 2, scopeFiles: 2, fileScope: "changed-files" }],
      [{ type: "gate-started", gateId: "lsp-diagnostics" }],
      [{ type: "gate-skipped", gateId: "lint", reason: "Skipped by filter" }],
      [{
        type: "gate-completed",
        gateId: "lsp-diagnostics",
        status: "passed",
        summary: "lsp-diagnostics: passed",
      }],
    ]);
  });

  test("uses the default LSP diagnostics integration when no override is provided", async () => {
    const report = await runQualityGates({
      platform: createPlatformWithLspSession(),
      cwd: "/tmp/project",
      gates: {
        "lsp-diagnostics": { enabled: true },
      },
      filters: {},
      reviewModel: defaultReviewModel,
      gateRegistry: {
        "lsp-diagnostics": lspDiagnosticsGate,
      },
    });

    expect(report.gates).toEqual([
      {
        gate: "lsp-diagnostics",
        status: "passed",
        summary: "LSP diagnostics passed with 1 warning(s) and no errors.",
        issues: [
          {
            severity: "warning",
            message: "Unused value",
            file: "src/review.ts",
            line: 4,
            detail: "column 2",
          },
        ],
      },
    ]);
    expect(report.summary).toEqual({ passed: 1, failed: 0, skipped: 0, blocked: 0 });
  });
});
