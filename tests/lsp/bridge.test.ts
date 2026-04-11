import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../../src/platform/types.js";
import { buildLspDiagnosticsPrompt, collectLspDiagnostics } from "../../src/lsp/bridge.js";

function createAgentSession(finalText: string): AgentSession {
  return {
    subscribe: () => () => {},
    prompt: async () => {},
    state: { messages: [{ role: "assistant", content: finalText }] },
    dispose: async () => {},
  };
}

describe("buildLspDiagnosticsPrompt", () => {
  test("uses workspace diagnostics instructions for all-files scope", () => {
    expect(buildLspDiagnosticsPrompt(["src/a.ts", "src/b.ts"], "all-files")).toContain('file "*"');
  });

  test("lists changed files for changed-files scope", () => {
    const prompt = buildLspDiagnosticsPrompt(["src/a.ts", "src/b.ts"], "changed-files");
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("- src/b.ts");
  });
});

describe("collectLspDiagnostics", () => {
  test("parses structured diagnostics into gate issues", async () => {
    const issues = await collectLspDiagnostics({
      cwd: "/tmp/project",
      scopeFiles: ["src/example.ts"],
      fileScope: "changed-files",
      reviewModel: { model: "claude-opus-4-6", thinkingLevel: "high" },
      createAgentSession: async () =>
        createAgentSession(
          JSON.stringify([
            {
              file: "src/example.ts",
              diagnostics: [
                { severity: "error", message: "Type mismatch", line: 8, column: 14 },
                { severity: "hint", message: "Unused value", line: 12, column: 3 },
              ],
            },
          ]),
        ),
    });

    expect(issues).toEqual([
      {
        severity: "error",
        message: "Type mismatch",
        file: "src/example.ts",
        line: 8,
        detail: "column 14",
      },
      {
        severity: "info",
        message: "Unused value",
        file: "src/example.ts",
        line: 12,
        detail: "column 3",
      },
    ]);
  });

  test("throws when the agent returns invalid JSON", async () => {
    await expect(
      collectLspDiagnostics({
        cwd: "/tmp/project",
        scopeFiles: ["src/example.ts"],
        fileScope: "changed-files",
        reviewModel: { model: "claude-opus-4-6", thinkingLevel: "high" },
        createAgentSession: async () => createAgentSession("not json"),
      }),
    ).rejects.toThrow(/invalid JSON/i);
  });
});
