import { describe, expect, mock, test } from "bun:test";
import type { AgentSession } from "../../src/platform/types.js";
import { buildLspDiagnosticsPrompt, collectLspDiagnostics } from "../../src/lsp/bridge.js";
import { FULL_LSP_SUPPORT, NO_LSP_SUPPORT } from "../../src/lsp/capabilities.js";

const CAPS_OK = JSON.stringify(FULL_LSP_SUPPORT);
const CAPS_NO_DIAGNOSTICS = JSON.stringify({ ...FULL_LSP_SUPPORT, diagnostics: false });
const CAPS_NONE = JSON.stringify(NO_LSP_SUPPORT);

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
    const { factory, calls } = createAgentSessionFactory([CAPS_OK, VALID_DIAGNOSTICS]);

    const issues = await collectLspDiagnostics({
      cwd: "/tmp/project",
      scopeFiles: ["src/example.ts"],
      fileScope: "changed-files",
      reviewModel: { model: "claude-opus-4-6", thinkingLevel: "high" },
      createAgentSession: factory as any,
    });

    expect(calls).toHaveLength(2);
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
    const { factory, calls, prompts } = createAgentSessionFactory([CAPS_OK, "not json", VALID_DIAGNOSTICS]);

    const issues = await collectLspDiagnostics({
      cwd: "/tmp/project",
      scopeFiles: ["src/example.ts"],
      fileScope: "changed-files",
      createAgentSession: factory as any,
    });

    expect(calls).toHaveLength(3);
    expect(issues).toHaveLength(2);
    // prompts[0] is the capability probe, prompts[1] is the first failed
    // diagnostics attempt, prompts[2] is the retry containing validator feedback.
    expect(prompts[2]).toContain("not json");
    expect(prompts[2]).toContain("severity:");
  });

  test("throws after retries exhaust on invalid JSON", async () => {
    const { factory, calls } = createAgentSessionFactory([CAPS_OK, "not json"]);

    await expect(
      collectLspDiagnostics({
        cwd: "/tmp/project",
        scopeFiles: ["src/example.ts"],
        fileScope: "changed-files",
        createAgentSession: factory as any,
      }),
    ).rejects.toThrow(/Invalid JSON/i);
    expect(calls).toHaveLength(4);
  });

  test("throws with field-level feedback on schema mismatch", async () => {
    const bad = JSON.stringify([
      { file: "src/a.ts", diagnostics: [{ severity: "fatal", message: "nope", line: 1, column: 1 }] },
    ]);
    const { factory } = createAgentSessionFactory([CAPS_OK, bad]);

    await expect(
      collectLspDiagnostics({
        cwd: "/tmp/project",
        scopeFiles: ["src/a.ts"],
        fileScope: "changed-files",
        createAgentSession: factory as any,
      }),
    ).rejects.toThrow(/diagnostics/);
  });

  test("returns [] when the capabilities probe says diagnostics: false", async () => {
    // Only the capability probe should run; the diagnostics flow must be
    // skipped entirely so the gate does not throw on a vacuous probe error.
    const { factory, calls } = createAgentSessionFactory([CAPS_NO_DIAGNOSTICS]);

    const issues = await collectLspDiagnostics({
      cwd: "/tmp/project",
      scopeFiles: ["src/example.ts"],
      fileScope: "changed-files",
      createAgentSession: factory as any,
    });

    expect(issues).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("returns [] when the capabilities probe fails (fail-closed)", async () => {
    // A probe that never parses must not let the diagnostics flow run; the
    // gate stays empty rather than running a workflow whose precondition is
    // unknown. The probe consumes its own retry budget (3 attempts) and
    // collectLspDiagnostics returns without invoking the diagnostics flow.
    const { factory, calls } = createAgentSessionFactory(["not json"]);

    const issues = await collectLspDiagnostics({
      cwd: "/tmp/project",
      scopeFiles: ["src/example.ts"],
      fileScope: "changed-files",
      createAgentSession: factory as any,
    });

    expect(issues).toEqual([]);
    // 3 probe attempts, no diagnostics attempts.
    expect(calls).toHaveLength(3);
  });

  test("returns [] when capabilities probe explicitly reports NO_LSP_SUPPORT", async () => {
    const { factory, calls } = createAgentSessionFactory([CAPS_NONE]);

    const issues = await collectLspDiagnostics({
      cwd: "/tmp/project",
      scopeFiles: ["src/example.ts"],
      fileScope: "changed-files",
      createAgentSession: factory as any,
    });

    expect(issues).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
