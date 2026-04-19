import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession, Platform, PlatformPaths } from "../../src/platform/types.js";
import { buildAiSetupPrompt, suggestQualityGatesWithAi } from "../../src/quality/ai-setup.js";
import type { ProjectFacts, SetupProposal } from "../../src/types.js";

function createTestPaths(rootDir: string): PlatformPaths {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) =>
      path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) =>
      path.join(rootDir, "global", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) => path.join(rootDir, "agent", ...segments),
  };
}

function createFakePlatform(finalTexts: string[]): { platform: Platform; calls: any[]; prompts: string[] } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ai-setup-test-"));
  const paths = createTestPaths(tmpDir);
  const calls: any[] = [];
  const prompts: string[] = [];
  let index = 0;

  const platform = {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    getCurrentModel: () => "claude-test",
    getModelForRole: () => null,
    createAgentSession: mock(async (options: any) => {
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
    }),
    paths,
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
  } as unknown as Platform;

  return { platform, calls, prompts };
}

const BASELINE_FACTS: ProjectFacts = {
  cwd: "/tmp/proj",
  packageScripts: { test: "bun test" },
  lockfiles: ["bun.lockb"],
  activeTools: [],
  existingGates: {},
  targets: [
    {
      name: "proj",
      kind: "root",
      relativeDir: ".",
      packageScripts: { test: "bun test" },
    },
  ],
};

const BASELINE_PROPOSAL: SetupProposal = {
  gates: {
    "test-suite": {
      enabled: true,
      runs: [{ command: "bun test", target: { scope: "all-targets" } }],
    },
  },
};

describe("buildAiSetupPrompt", () => {
  test("embeds the rendered QualityGatesConfig schema for retry self-correction", () => {
    const prompt = buildAiSetupPrompt(BASELINE_FACTS, {
      ...BASELINE_PROPOSAL,
      notes: ["Typecheck: Detected typecheck commands in workspace targets only."],
    });
    expect(prompt).toContain("lsp-diagnostics");
    expect(prompt).toContain("typecheck");
    expect(prompt).toContain("test-suite");
    expect(prompt).toContain("build");
    expect(prompt).toContain("enabled:");
    expect(prompt).toContain("runs:");
    expect(prompt).toContain("all-targets");
    expect(prompt).toContain("workspace");
    expect(prompt).toContain("bun test");
    expect(prompt).toContain("shared across every discovered target");
    expect(prompt).toContain("/supi:checks All must cover the root target and every workspace target deterministically");
    expect(prompt).toContain("add target-specific runs");
    expect(prompt).toContain("Deterministic baseline notes:");
    expect(prompt).toContain("workspace targets only");
  });
});

describe("suggestQualityGatesWithAi", () => {
  test("parses a valid QualityGatesConfig payload", async () => {
    const valid = JSON.stringify({
      lint: {
        enabled: true,
        runs: [{ command: "eslint .", target: { scope: "all-targets" } }],
      },
      typecheck: {
        enabled: true,
        runs: [{ command: "tsc --noEmit", target: { scope: "all-workspaces" } }],
      },
      "test-suite": {
        enabled: true,
        runs: [{ command: "bun test", target: { scope: "all-targets" } }],
      },
    });
    const { platform, calls } = createFakePlatform([valid]);

    const result = await suggestQualityGatesWithAi({
      platform,
      cwd: "/tmp/proj",
      projectFacts: BASELINE_FACTS,
      proposal: BASELINE_PROPOSAL,
    });

    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      lint: { enabled: true, runs: [{ command: "eslint .", target: { scope: "all-targets" } }] },
      typecheck: {
        enabled: true,
        runs: [{ command: "tsc --noEmit", target: { scope: "all-workspaces" } }],
      },
      "test-suite": { enabled: true, runs: [{ command: "bun test", target: { scope: "all-targets" } }] },
    });
  });

  test("retries with validator feedback when first output fails schema", async () => {
    const invalid = JSON.stringify({ lint: { enabled: true } }); // missing runs
    const valid = JSON.stringify({
      "test-suite": {
        enabled: true,
        runs: [{ command: "bun test", target: { scope: "all-targets" } }],
      },
    });
    const { platform, calls, prompts } = createFakePlatform([invalid, valid]);

    const result = await suggestQualityGatesWithAi({
      platform,
      cwd: "/tmp/proj",
      projectFacts: BASELINE_FACTS,
      proposal: BASELINE_PROPOSAL,
    });

    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      "test-suite": {
        enabled: true,
        runs: [{ command: "bun test", target: { scope: "all-targets" } }],
      },
    });
    expect(prompts[1]).toContain("enabled:");
    expect(prompts[1]).toContain("runs");
    expect(prompts[1]).toContain("lint");
  });

  test("throws when the agent keeps returning invalid JSON", async () => {
    const { platform, calls } = createFakePlatform(["nope", "still nope", "never json"]);

    await expect(
      suggestQualityGatesWithAi({
        platform,
        cwd: "/tmp/proj",
        projectFacts: BASELINE_FACTS,
        proposal: BASELINE_PROPOSAL,
      }),
    ).rejects.toThrow(/Invalid JSON/i);
    expect(calls).toHaveLength(3);
  });

  test("throws on schema mismatch with field-level message", async () => {
    const badPayload = JSON.stringify({
      lint: {
        enabled: true,
        runs: [{ command: "eslint", target: { scope: "workspace" } }],
      },
    });
    const { platform } = createFakePlatform([badPayload, badPayload, badPayload]);

    await expect(
      suggestQualityGatesWithAi({
        platform,
        cwd: "/tmp/proj",
        projectFacts: BASELINE_FACTS,
        proposal: BASELINE_PROPOSAL,
      }),
    ).rejects.toThrow(/lint/);
  });
});
