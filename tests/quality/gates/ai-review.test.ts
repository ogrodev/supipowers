import { describe, expect, mock, test } from "bun:test";
import type { AgentSession } from "../../../src/platform/types.js";
import type {
  GateExecutionContext,
  GateIssue,
  ProjectFacts,
} from "../../../src/types.js";
import { aiReviewGate } from "../../../src/quality/gates/ai-review.js";

function createProjectFacts(): ProjectFacts {
  return {
    cwd: "/repo",
    packageScripts: {},
    lockfiles: [],
    activeTools: [],
    existingGates: {},
  };
}

function createAgentSessionWithFinalText(finalText: string): AgentSession {
  return {
    subscribe: () => () => {},
    prompt: async () => {},
    state: {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
        },
      ],
    },
    dispose: async () => {},
  };
}

function createContextWithFinalText(finalText: string) {
  const mockCreateAgentSession = mock(async () => createAgentSessionWithFinalText(finalText));

  const context: GateExecutionContext = {
    cwd: "/repo",
    changedFiles: ["src/review.ts"],
    scopeFiles: ["src/review.ts"],
    fileScope: "changed-files",
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    execShell: async () => ({ stdout: "", stderr: "", code: 0 }),
    getLspDiagnostics: async (): Promise<GateIssue[]> => [],
    createAgentSession: mockCreateAgentSession,
    activeTools: [],
    reviewModel: { model: "claude-opus-4-6", thinkingLevel: "high" },
  };

  return { context, mockCreateAgentSession };
}

describe("aiReviewGate.detect", () => {
  test("returns the default review recommendation", () => {
    expect(aiReviewGate.detect(createProjectFacts())).toEqual({
      suggestedConfig: { enabled: true, depth: "deep" },
      confidence: "medium",
      reason: "AI review is the default human-readable gate.",
    });
  });
});

describe("aiReviewGate.run", () => {
  test("rejects malformed JSON output", async () => {
    const { context } = createContextWithFinalText("not json");

    const result = await aiReviewGate.run(context, { enabled: true, depth: "deep" });

    expect(result).toEqual({
      gate: "ai-review",
      status: "blocked",
      summary: "AI review returned invalid JSON.",
      issues: [],
      metadata: { rawOutput: "not json" },
    });
  });

  test("uses the resolved review model in the agent session", async () => {
    const { context, mockCreateAgentSession } = createContextWithFinalText(
      '{"summary":"ok","issues":[],"recommendedStatus":"passed"}',
    );

    await aiReviewGate.run(context, { enabled: true, depth: "deep" });

    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-6", thinkingLevel: "high" }),
    );
  });

  test("maps structured payloads into gate results", async () => {
    const { context } = createContextWithFinalText(
      JSON.stringify({
        summary: "Found one warning.",
        issues: [
          {
            severity: "warning",
            message: "Prefer narrower type.",
            file: "src/review.ts",
            line: 12,
          },
        ],
        recommendedStatus: "failed",
      }),
    );

    const result = await aiReviewGate.run(context, { enabled: true, depth: "deep" });

    expect(result).toEqual({
      gate: "ai-review",
      status: "failed",
      summary: "Found one warning.",
      issues: [
        {
          severity: "warning",
          message: "Prefer narrower type.",
          file: "src/review.ts",
          line: 12,
        },
      ],
      metadata: { depth: "deep" },
    });
  });
});
