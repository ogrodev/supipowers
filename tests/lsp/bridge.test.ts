import { describe, expect, mock, test } from "bun:test";
import type { AgentSession } from "../../src/platform/types.js";
import { buildLspDiagnosticsPrompt, collectLspDiagnostics } from "../../src/lsp/bridge.js";

function createAgentSessionFactory(finalTexts: string[]) {
  const calls: any[] = [];
  const prompts: string[] = [];
  let index = 0;
  const factory = mock(async (options: any) => {
    calls.push(options);
    const text = finalTexts[Math.min(index, finalTexts.length - 1)];
    index += 1;
    const session: AgentSession = {
      subscribe: () => () => {},
      prompt: async (promptText: string) => {
        prompts.push(promptText);
      },
      state: {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "text", text }] },
        ],
      },
      dispose: async () => {},
    } as unknown as AgentSession;
    return session;
  });
  return { factory, calls, prompts };
}

const VALID_DIAGNOSTICS = JSON.stringify([
  {
    file: "src/example.ts",
    diagnostics: [
      { severity: "error", message: "Type mismatch", line: 8, column: 14 },
      { severity: "hint", message: "Unused value", line: 12, column: 3 },
    ],
  },
]);

describe("buildLspDiagnosticsPrompt", () => {
  test("uses workspace diagnostics instructions for all-files scope", () => {
    expect(buildLspDiagnosticsPrompt(["src/a.ts", "src/b.ts"], "all-files")).toContain('file "*"');
  });

  test("lists changed files for changed-files scope", () => {
    const prompt = buildLspDiagnosticsPrompt(["src/a.ts", "src/b.ts"], "changed-files");
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("- src/b.ts");
  });

  test("embeds the rendered diagnostics schema for retry self-correction", () => {
    const prompt = buildLspDiagnosticsPrompt(["src/a.ts"], "changed-files");
    expect(prompt).toContain("severity:");
    expect(prompt).toContain("line:");
    expect(prompt).toContain("column:");
    expect(prompt).toContain('"error"');
    expect(prompt).toContain('"hint"');
  });
});

describe("collectLspDiagnostics", () => {
  test("parses structured diagnostics into gate issues", async () => {
    const { factory, calls } = createAgentSessionFactory([VALID_DIAGNOSTICS]);

    const issues = await collectLspDiagnostics({
      cwd: "/tmp/project",
      scopeFiles: ["src/example.ts"],
      fileScope: "changed-files",
      reviewModel: { model: "claude-opus-4-6", thinkingLevel: "high" },
      createAgentSession: factory as any,
    });

    expect(calls).toHaveLength(1);
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

  test("retries with validator feedback and succeeds on the second attempt", async () => {
    const { factory, calls, prompts } = createAgentSessionFactory(["not json", VALID_DIAGNOSTICS]);

    const issues = await collectLspDiagnostics({
      cwd: "/tmp/project",
      scopeFiles: ["src/example.ts"],
      fileScope: "changed-files",
      createAgentSession: factory as any,
    });

    expect(calls).toHaveLength(2);
    expect(issues).toHaveLength(2);
    expect(prompts[1]).toContain("not json");
    expect(prompts[1]).toContain("severity:");
  });

  test("throws after retries exhaust on invalid JSON", async () => {
    const { factory, calls } = createAgentSessionFactory(["not json"]);

    await expect(
      collectLspDiagnostics({
        cwd: "/tmp/project",
        scopeFiles: ["src/example.ts"],
        fileScope: "changed-files",
        createAgentSession: factory as any,
      }),
    ).rejects.toThrow(/Invalid JSON/i);
    expect(calls).toHaveLength(3);
  });

  test("throws with field-level feedback on schema mismatch", async () => {
    const bad = JSON.stringify([
      { file: "src/a.ts", diagnostics: [{ severity: "fatal", message: "nope", line: 1, column: 1 }] },
    ]);
    const { factory } = createAgentSessionFactory([bad]);

    await expect(
      collectLspDiagnostics({
        cwd: "/tmp/project",
        scopeFiles: ["src/a.ts"],
        fileScope: "changed-files",
        createAgentSession: factory as any,
      }),
    ).rejects.toThrow(/diagnostics/);
  });
});
