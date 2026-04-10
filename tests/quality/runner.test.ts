import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { runQualityGates } from "../../src/quality/runner.js";
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
        "ai-review": { enabled: true, depth: "deep" },
        "lsp-diagnostics": { enabled: true },
      },
      filters: {},
      reviewModel: defaultReviewModel,
      gateRegistry: {
        "lsp-diagnostics": createGate("lsp-diagnostics"),
        "ai-review": createGate("ai-review"),
      },
      now: () => new Date("2026-04-10T00:00:00.000Z"),
    });

    expect(report.selectedGates).toEqual(["lsp-diagnostics", "ai-review"]);
    expect(report.summary).toEqual({ passed: 2, failed: 0, skipped: 0, blocked: 0 });
    expect(report.overallStatus).toBe("passed");
  });

  test("records skipped gates and omits disabled gates", async () => {
    const report = await runQualityGates({
      platform: createPlatform(),
      cwd: "/tmp/project",
      gates: {
        "lsp-diagnostics": { enabled: true },
        "ai-review": { enabled: true, depth: "deep" },
        "test-suite": { enabled: false, command: null },
      },
      filters: { skip: ["ai-review"] },
      reviewModel: { model: "claude-opus-4-6", thinkingLevel: null, source: "action" },
      gateRegistry: {
        "lsp-diagnostics": createGate("lsp-diagnostics"),
        "ai-review": createGate("ai-review"),
        "test-suite": createGate("test-suite"),
      },
    });

    expect(report.gates.find((gate) => gate.gate === "ai-review")?.status).toBe("skipped");
    expect(report.gates.find((gate) => gate.gate === "test-suite")).toBeUndefined();
    expect(report.summary).toEqual({ passed: 1, failed: 0, skipped: 1, blocked: 0 });
  });
});
