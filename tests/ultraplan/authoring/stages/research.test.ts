import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ResearchStage } from "../../../../src/ultraplan/authoring/stages/research.js";
import {
  getUltraplanAuthoringDecisionsPath,
  getUltraplanAuthoringIntakePath,
  getUltraplanAuthoringResearchStackPath,
  getUltraplanAuthoringResearchSummaryPath,
  getUltraplanAuthoringScoutPath,
} from "../../../../src/ultraplan/project-paths.js";
import { saveUltraPlanManifest } from "../../../../src/ultraplan/storage.js";
import {
  loadAuthoringState,
  saveIntakeArtifact,
  saveScoutArtifact,
  saveResearchStackArtifact,
  saveResearchSummary,
} from "../../../../src/ultraplan/authoring/storage.js";
import type { ModelConfig } from "../../../../src/types.js";
import { createTestPaths, createTestRepo, makeUltraPlanManifest } from "../../fixtures.js";

const SESSION_ID = "up-author-research-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-research-stage-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;
  saveUltraPlanManifest(paths, cwd, SESSION_ID, makeUltraPlanManifest({ sessionId: SESSION_ID }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = "2026-04-30T16:00:00.000Z";

const BASE_MODEL_CONFIG: ModelConfig = { version: "1", default: null, actions: {} };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeDecision(decision: Record<string, unknown> = { area: "auth", decision: "jwt" }): void {
  const decisionsPath = getUltraplanAuthoringDecisionsPath(paths, cwd, SESSION_ID);
  fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });
  fs.appendFileSync(decisionsPath, `${JSON.stringify(decision)}\n`);
}

function writeIntake(
  candidateStacks: Array<{ stack: string; applicability: string }>,
): void {
  saveIntakeArtifact(paths, cwd, SESSION_ID, {
    sessionId: SESSION_ID,
    title: "Test session",
    goal: "Build something",
    candidateStacks,
  });
}

function writeScout(): void {
  saveScoutArtifact(paths, cwd, SESSION_ID, {
    sessionId: SESSION_ID,
    reusableAssets: [],
  });
}

function seedPrerequisites(
  candidateStacks: Array<{ stack: string; applicability: string }>,
): void {
  writeIntake(candidateStacks);
  writeScout();
  writeDecision();
}

/**
 * Build a platform mock where each `createAgentSession` call returns a distinct
 * session. When the session's prompt mock is called, it writes `<stack>.md` if
 * the stack appears in `writeArtifactsForStacks`.
 *
 * The stack for a session is inferred from its `agentDisplayName`, which follows
 * the convention `ultraplan-authoring-research/<stack>`.
 */
function makePlatform(opts: {
  writeArtifactsForStacks?: string[];
} = {}) {
  const agentSessionCalls: Array<Record<string, unknown>> = [];

  const createAgentSession = mock(async (sessionOpts: Record<string, unknown>) => {
    agentSessionCalls.push({ ...sessionOpts });

    // Infer the stack for this session from the display name.
    const displayName = (sessionOpts.agentDisplayName as string) ?? "";
    const stack = displayName.includes("/") ? displayName.split("/")[1] : null;

    return {
      subscribe: mock(() => () => {}),
      state: { messages: [] as unknown[] },
      prompt: mock(async () => {
        if (stack && opts.writeArtifactsForStacks?.includes(stack)) {
          const filePath = getUltraplanAuthoringResearchStackPath(
            paths,
            cwd,
            SESSION_ID,
            stack as "frontend" | "backend" | "infrastructure",
          );
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(
            filePath,
            [
              `# Research for ${stack}`,
              ``,
              `## Overview`,
              `Key findings for the ${stack} stack.`,
              `Line 5`,
              `Line 6`,
              `Line 7`,
              `Line 8`,
              `Line 9`,
              `Line 10`,
              `Line 11 (should be excluded from summary excerpt)`,
            ].join("\n"),
          );
        }
      }),
      dispose: mock(async () => {}),
    };
  });

  const platform = {
    paths,
    createAgentSession,
    getModelForRole: mock(() => null),
    getCurrentModel: mock(() => "main-default"),
  };

  return {
    platform,
    createAgentSession,
    getSessionCalls: () => agentSessionCalls,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(
  platform: any,
  overrides: {
    modelConfig?: ModelConfig;
    modelOverride?: { model: string; thinkingLevel: string | null };
    /** Pass true to omit modelOverride entirely, letting per-action resolution run. */
    noModelOverride?: true;
  } = {},
) {
  return {
    platform,
    paths,
    cwd,
    sessionId: SESSION_ID,
    modelConfig: overrides.modelConfig ?? BASE_MODEL_CONFIG,
    now: () => NOW,
    ...(!overrides.noModelOverride
      ? {
          modelOverride:
            overrides.modelOverride ?? { model: "test-model", thinkingLevel: null as string | null },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// isReady
// ---------------------------------------------------------------------------

describe("research stage · isReady", () => {
  test("false when intake is missing", async () => {
    const { platform } = makePlatform();
    const stage = new ResearchStage();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("false when scout is missing (intake present)", async () => {
    writeIntake([{ stack: "backend", applicability: "applicable" }]);
    const { platform } = makePlatform();
    const stage = new ResearchStage();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("false when decisions.jsonl is missing (intake + scout present)", async () => {
    writeIntake([{ stack: "backend", applicability: "applicable" }]);
    writeScout();
    const { platform } = makePlatform();
    const stage = new ResearchStage();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("false when decisions.jsonl is empty", async () => {
    writeIntake([{ stack: "backend", applicability: "applicable" }]);
    writeScout();
    const decisionsPath = getUltraplanAuthoringDecisionsPath(paths, cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });
    fs.writeFileSync(decisionsPath, "\n\n\n"); // whitespace-only lines
    const { platform } = makePlatform();
    const stage = new ResearchStage();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("true when intake + scout + non-empty decisions all exist", async () => {
    seedPrerequisites([{ stack: "backend", applicability: "applicable" }]);
    const { platform } = makePlatform();
    const stage = new ResearchStage();
    expect(await stage.isReady(ctx(platform))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isComplete
// ---------------------------------------------------------------------------

describe("research stage · isComplete", () => {
  test("false when SUMMARY.md is missing", async () => {
    seedPrerequisites([{ stack: "backend", applicability: "applicable" }]);
    saveResearchStackArtifact(paths, cwd, SESSION_ID, "backend", "# backend");
    const { platform } = makePlatform();
    const stage = new ResearchStage();
    expect(await stage.isComplete(ctx(platform))).toBe(false);
  });

  test("false when a required stack artifact is missing (SUMMARY exists)", async () => {
    seedPrerequisites([
      { stack: "backend", applicability: "applicable" },
      { stack: "frontend", applicability: "applicable" },
    ]);
    saveResearchStackArtifact(paths, cwd, SESSION_ID, "backend", "# backend");
    // frontend.md intentionally missing
    saveResearchSummary(paths, cwd, SESSION_ID, "## backend\n\nstuff\n");
    const { platform } = makePlatform();
    const stage = new ResearchStage();
    expect(await stage.isComplete(ctx(platform))).toBe(false);
  });

  test("true when all applicable stacks + SUMMARY exist", async () => {
    seedPrerequisites([{ stack: "backend", applicability: "applicable" }]);
    saveResearchStackArtifact(paths, cwd, SESSION_ID, "backend", "# backend");
    saveResearchSummary(paths, cwd, SESSION_ID, "## backend\n\nstuff\n");
    const { platform } = makePlatform();
    const stage = new ResearchStage();
    expect(await stage.isComplete(ctx(platform))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// run() — prerequisite failures
// ---------------------------------------------------------------------------

describe("research stage · run() prerequisite failures", () => {
  test("returns failed when intake is missing (no agent spawned)", async () => {
    const { platform, createAgentSession } = makePlatform();
    const stage = new ResearchStage();
    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(createAgentSession).toHaveBeenCalledTimes(0);
  });

  test("returns failed when decisions.jsonl is missing", async () => {
    writeIntake([{ stack: "backend", applicability: "applicable" }]);
    writeScout();
    // no decisions file
    const { platform, createAgentSession } = makePlatform();
    const stage = new ResearchStage();
    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(createAgentSession).toHaveBeenCalledTimes(0);
    expect(result.error).toContain("decisions.jsonl");
  });
});

// ---------------------------------------------------------------------------
// run() — parallel fan-out (1 / 2 / 3 stacks)
// ---------------------------------------------------------------------------

describe("research stage · run() parallel fan-out", () => {
  test("1 applicable stack: spawns exactly 1 agent session", async () => {
    seedPrerequisites([
      { stack: "backend", applicability: "applicable" },
      { stack: "frontend", applicability: "not-applicable" },
      { stack: "infrastructure", applicability: "not-applicable" },
    ]);

    const { platform, createAgentSession } = makePlatform({
      writeArtifactsForStacks: ["backend"],
    });
    const stage = new ResearchStage();
    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("completed");
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    const call = createAgentSession.mock.calls[0]![0] as Record<string, unknown>;
    expect((call.agentDisplayName as string).endsWith("/backend")).toBe(true);
  });

  test("2 applicable stacks: spawns exactly 2 agent sessions", async () => {
    seedPrerequisites([
      { stack: "backend", applicability: "applicable" },
      { stack: "frontend", applicability: "applicable" },
      { stack: "infrastructure", applicability: "not-applicable" },
    ]);

    const { platform, createAgentSession } = makePlatform({
      writeArtifactsForStacks: ["backend", "frontend"],
    });
    const stage = new ResearchStage();
    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("completed");
    expect(createAgentSession).toHaveBeenCalledTimes(2);
  });

  test("3 applicable stacks: spawns exactly 3 agent sessions", async () => {
    seedPrerequisites([
      { stack: "backend", applicability: "applicable" },
      { stack: "frontend", applicability: "applicable" },
      { stack: "infrastructure", applicability: "applicable" },
    ]);

    const { platform, createAgentSession } = makePlatform({
      writeArtifactsForStacks: ["backend", "frontend", "infrastructure"],
    });
    const stage = new ResearchStage();
    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("completed");
    expect(createAgentSession).toHaveBeenCalledTimes(3);
    // Every stack artifact + SUMMARY exist on disk.
    expect(
      fs.existsSync(getUltraplanAuthoringResearchStackPath(paths, cwd, SESSION_ID, "frontend")),
    ).toBe(true);
    expect(
      fs.existsSync(getUltraplanAuthoringResearchStackPath(paths, cwd, SESSION_ID, "backend")),
    ).toBe(true);
    expect(
      fs.existsSync(
        getUltraplanAuthoringResearchStackPath(paths, cwd, SESSION_ID, "infrastructure"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(getUltraplanAuthoringResearchSummaryPath(paths, cwd, SESSION_ID)),
    ).toBe(true);
  });

  test("artifactPaths lists all stack files + SUMMARY", async () => {
    seedPrerequisites([
      { stack: "backend", applicability: "applicable" },
      { stack: "frontend", applicability: "applicable" },
    ]);

    const { platform } = makePlatform({
      writeArtifactsForStacks: ["backend", "frontend"],
    });
    const stage = new ResearchStage();
    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("completed");
    expect(result.artifactPaths).toContain("authoring/research/backend.md");
    expect(result.artifactPaths).toContain("authoring/research/frontend.md");
    expect(result.artifactPaths).toContain("authoring/research/SUMMARY.md");
  });
});

// ---------------------------------------------------------------------------
// run() — per-stack model override
// ---------------------------------------------------------------------------

describe("research stage · run() per-stack model override", () => {
  test("per-stack action config overrides model for the specified stack", async () => {
    seedPrerequisites([{ stack: "backend", applicability: "applicable" }]);

    const { platform, createAgentSession } = makePlatform({
      writeArtifactsForStacks: ["backend"],
    });

    const modelConfig: ModelConfig = {
      version: "1",
      default: null,
      actions: {
        "ultraplan.authoring.researcher.backend": {
          model: "backend-special-model",
          thinkingLevel: null,
        },
      },
    };

    const stage = new ResearchStage();
    // Do NOT set modelOverride so the per-action resolution runs.
    const result = await stage.run(
      ctx(platform, { modelConfig, noModelOverride: true }),
    );

    expect(result.status).toBe("completed");
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    const opts = createAgentSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.model).toBe("backend-special-model");
  });

  test("modelOverride applies to all stacks when set", async () => {
    seedPrerequisites([
      { stack: "backend", applicability: "applicable" },
      { stack: "frontend", applicability: "applicable" },
    ]);

    const { platform, createAgentSession } = makePlatform({
      writeArtifactsForStacks: ["backend", "frontend"],
    });

    const stage = new ResearchStage();
    // modelOverride is set via default ctx() factory
    await stage.run(ctx(platform));

    expect(createAgentSession).toHaveBeenCalledTimes(2);
    for (const [callArgs] of createAgentSession.mock.calls) {
      const opts = callArgs as Record<string, unknown>;
      expect(opts.model).toBe("test-model");
    }
  });
});

// ---------------------------------------------------------------------------
// run() — skip-stack invariant
// ---------------------------------------------------------------------------

describe("research stage · run() skip-stack invariant", () => {
  test("stale artifact for non-applicable stack is deleted", async () => {
    // Only backend is applicable; a stale frontend.md exists from a prior run.
    seedPrerequisites([
      { stack: "backend", applicability: "applicable" },
      { stack: "frontend", applicability: "not-applicable" },
    ]);

    // Pre-seed the stale frontend artifact.
    saveResearchStackArtifact(paths, cwd, SESSION_ID, "frontend", "# stale frontend data");
    expect(
      fs.existsSync(getUltraplanAuthoringResearchStackPath(paths, cwd, SESSION_ID, "frontend")),
    ).toBe(true);

    const { platform } = makePlatform({ writeArtifactsForStacks: ["backend"] });
    const stage = new ResearchStage();
    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("completed");

    // Stale artifact removed.
    expect(
      fs.existsSync(getUltraplanAuthoringResearchStackPath(paths, cwd, SESSION_ID, "frontend")),
    ).toBe(false);

    // Backend artifact present.
    expect(
      fs.existsSync(getUltraplanAuthoringResearchStackPath(paths, cwd, SESSION_ID, "backend")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// run() — partial failure → blocked
// ---------------------------------------------------------------------------

describe("research stage · run() partial failure", () => {
  test("blocked when one researcher fails to write its artifact", async () => {
    seedPrerequisites([
      { stack: "backend", applicability: "applicable" },
      { stack: "frontend", applicability: "applicable" },
    ]);

    // Only backend writes; frontend researcher silently fails.
    const { platform } = makePlatform({ writeArtifactsForStacks: ["backend"] });
    const stage = new ResearchStage();
    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("blocked");
    expect(result.blocker).toBeDefined();
    expect(result.blocker!.code).toBe("research-incomplete");
    expect(result.blocker!.recoveryMode).toBe("retry");
    expect((result.blocker!.details as Record<string, unknown>).missingStacks).toContain(
      "frontend",
    );
  });

  test("blocked result does not include SUMMARY.md in artifactPaths", async () => {
    seedPrerequisites([{ stack: "backend", applicability: "applicable" }]);

    // No stack writes its artifact.
    const { platform } = makePlatform({ writeArtifactsForStacks: [] });
    const stage = new ResearchStage();
    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("blocked");
    expect(result.artifactPaths).toHaveLength(0);
    // SUMMARY.md must not exist on disk either.
    expect(
      fs.existsSync(getUltraplanAuthoringResearchSummaryPath(paths, cwd, SESSION_ID)),
    ).toBe(false);
  });

  test("authoring state reflects blocked status on manifest", async () => {
    seedPrerequisites([{ stack: "backend", applicability: "applicable" }]);

    const { platform } = makePlatform({ writeArtifactsForStacks: [] });
    const stage = new ResearchStage();
    await stage.run(ctx(platform));

    const stateResult = loadAuthoringState(paths, cwd, SESSION_ID);
    expect(stateResult.ok).toBe(true);
    if (stateResult.ok) {
      expect(stateResult.value?.stageStatus).toBe("blocked");
      expect(stateResult.value?.blocker).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// run() — idempotent skip
// ---------------------------------------------------------------------------

describe("research stage · run() idempotent skip", () => {
  test("skipped when all stack artifacts + SUMMARY exist before run()", async () => {
    seedPrerequisites([{ stack: "backend", applicability: "applicable" }]);
    saveResearchStackArtifact(paths, cwd, SESSION_ID, "backend", "# backend");
    saveResearchSummary(paths, cwd, SESSION_ID, "## backend\n\nstuff\n");

    const { platform, createAgentSession } = makePlatform();
    const stage = new ResearchStage();
    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("skipped");
    expect(createAgentSession).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// run() — SUMMARY.md content
// ---------------------------------------------------------------------------

describe("research stage · run() SUMMARY.md content", () => {
  test("SUMMARY.md contains a ## heading for each applicable stack", async () => {
    seedPrerequisites([
      { stack: "backend", applicability: "applicable" },
      { stack: "frontend", applicability: "applicable" },
    ]);

    const { platform } = makePlatform({
      writeArtifactsForStacks: ["backend", "frontend"],
    });
    const stage = new ResearchStage();
    await stage.run(ctx(platform));

    const summaryPath = getUltraplanAuthoringResearchSummaryPath(paths, cwd, SESSION_ID);
    const summary = fs.readFileSync(summaryPath, "utf8");
    expect(summary).toContain("## backend");
    expect(summary).toContain("## frontend");
  });

  test("SUMMARY.md excerpt truncates to first 10 lines", async () => {
    seedPrerequisites([{ stack: "backend", applicability: "applicable" }]);

    // The mock writes 11 lines; line 11 should be excluded.
    const { platform } = makePlatform({ writeArtifactsForStacks: ["backend"] });
    const stage = new ResearchStage();
    await stage.run(ctx(platform));

    const summaryPath = getUltraplanAuthoringResearchSummaryPath(paths, cwd, SESSION_ID);
    const summary = fs.readFileSync(summaryPath, "utf8");
    expect(summary).not.toContain("Line 11 (should be excluded from summary excerpt)");
    expect(summary).toContain("Line 10");
  });
});

// ---------------------------------------------------------------------------
// run() — authoring state on success
// ---------------------------------------------------------------------------

describe("research stage · run() authoring state", () => {
  test("manifest authoring block is updated to done on success", async () => {
    seedPrerequisites([{ stack: "backend", applicability: "applicable" }]);

    const { platform } = makePlatform({ writeArtifactsForStacks: ["backend"] });
    const stage = new ResearchStage();
    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("completed");

    const stateResult = loadAuthoringState(paths, cwd, SESSION_ID);
    expect(stateResult.ok).toBe(true);
    if (stateResult.ok) {
      expect(stateResult.value?.stage).toBe("research");
      expect(stateResult.value?.stageStatus).toBe("done");
      expect(stateResult.value?.blocker).toBeNull();
      expect(stateResult.value?.artifacts.research).toBeDefined();
      expect(stateResult.value?.artifacts.researchSummary).toBe(
        "authoring/research/SUMMARY.md",
      );
    }
  });

  test("intake is embedded verbatim in the per-stack assignment prompt", async () => {
    seedPrerequisites([{ stack: "backend", applicability: "applicable" }]);

    const promptTexts: string[] = [];
    // Custom platform to capture prompt calls.
    const session = {
      subscribe: mock(() => () => {}),
      state: { messages: [] as unknown[] },
      prompt: mock(async (text: string) => {
        promptTexts.push(text);
        const filePath = getUltraplanAuthoringResearchStackPath(
          paths,
          cwd,
          SESSION_ID,
          "backend",
        );
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "# backend research");
      }),
      dispose: mock(async () => {}),
    };
    const createAgentSession = mock(async () => session);
    const customPlatform = {
      paths,
      createAgentSession,
      getModelForRole: mock(() => null),
      getCurrentModel: mock(() => "main-default"),
    };

    const stage = new ResearchStage();
    await stage.run(ctx(customPlatform));

    expect(promptTexts.length).toBe(1);
    // The intake goal appears in the prompt.
    expect(promptTexts[0]).toContain("Build something");
    // The session id is present so the agent can pass it back.
    expect(promptTexts[0]).toContain(JSON.stringify(SESSION_ID));
    // Stack identifier is present.
    expect(promptTexts[0]).toContain("backend");
  });
});
