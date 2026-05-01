import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { IntakeStage } from "../../../../src/ultraplan/authoring/stages/intake.js";
import {
  getUltraplanAuthoringIntakePath,
} from "../../../../src/ultraplan/project-paths.js";
import { saveUltraPlanManifest } from "../../../../src/ultraplan/storage.js";
import {
  loadAuthoringState,
} from "../../../../src/ultraplan/authoring/storage.js";
import type { ModelConfig } from "../../../../src/types.js";
import { createTestPaths, createTestRepo, makeUltraPlanManifest } from "../../fixtures.js";

const SESSION_ID = "up-author-intake-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-intake-stage-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;
  // Seed manifest so saveAuthoringState has somewhere to land.
  saveUltraPlanManifest(paths, cwd, SESSION_ID, makeUltraPlanManifest({ sessionId: SESSION_ID }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = "2026-04-30T15:00:00.000Z";

interface FakePromptCall {
  text: string;
}

function makePlatform(opts: { writeIntakeOnPrompt?: unknown } = {}) {
  const promptCalls: FakePromptCall[] = [];
  let disposed = 0;
  const session = {
    subscribe: mock(() => () => {}),
    state: { messages: [] as unknown[] },
    prompt: mock(async (text: string) => {
      promptCalls.push({ text });
      // Simulate the agent's `ultraplan_intake_record` tool call by writing the artifact.
      if (opts.writeIntakeOnPrompt) {
        const filePath = getUltraplanAuthoringIntakePath(paths, cwd, SESSION_ID);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(opts.writeIntakeOnPrompt, null, 2));
      }
    }),
    dispose: mock(async () => {
      disposed += 1;
    }),
  };
  const createAgentSession = mock(async () => session);
  const platform = {
    paths,
    createAgentSession,
    getModelForRole: mock(() => null),
    getCurrentModel: mock(() => "main-default"),
  };
  return { platform, session, createAgentSession, promptCalls, getDisposeCount: () => disposed };
}

const MODEL_CONFIG: ModelConfig = { version: "1", default: null, actions: {} };

function ctx(platform: any) {
  return {
    platform,
    paths,
    cwd,
    sessionId: SESSION_ID,
    modelConfig: MODEL_CONFIG,
    now: () => NOW,
    modelOverride: { model: "test-model", thinkingLevel: null },
  };
}

describe("intake stage", () => {
  test("isReady returns false when seed is empty", async () => {
    const stage = new IntakeStage({ seedPrompt: "  " });
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("isReady true with non-empty seed", async () => {
    const stage = new IntakeStage({ seedPrompt: "build auth" });
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(true);
  });

  test("isComplete false when no artifact", async () => {
    const stage = new IntakeStage({ seedPrompt: "build auth" });
    const { platform } = makePlatform();
    expect(await stage.isComplete(ctx(platform))).toBe(false);
  });

  test("run() spawns one agent session and writes the artifact (via simulated tool call)", async () => {
    const stage = new IntakeStage({ seedPrompt: "Build user authentication with sign-in and sign-up." });
    const { platform, createAgentSession, promptCalls, getDisposeCount } = makePlatform({
      writeIntakeOnPrompt: {
        sessionId: SESSION_ID,
        title: "Build user auth",
        goal: "Ship sign-in and sign-up",
        candidateStacks: [{ stack: "backend", applicability: "applicable" }],
      },
    });

    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("completed");
    expect(result.stage).toBe("intake");
    expect(result.artifactPaths).toContain("authoring/intake.json");

    // Exactly one agent session spawned, prompted, disposed.
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(promptCalls.length).toBe(1);
    expect(getDisposeCount()).toBe(1);

    // Seed prompt is plumbed verbatim into the assignment.
    expect(promptCalls[0]!.text.includes("Build user authentication with sign-in and sign-up.")).toBe(true);

    // sessionId is referenced literally in the assignment so the agent passes it back.
    expect(promptCalls[0]!.text.includes(JSON.stringify(SESSION_ID))).toBe(true);

    // Authoring state is updated on the manifest.
    const stateResult = loadAuthoringState(paths, cwd, SESSION_ID);
    expect(stateResult.ok).toBe(true);
    if (stateResult.ok) {
      expect(stateResult.value).not.toBeNull();
      expect(stateResult.value?.stage).toBe("intake");
      expect(stateResult.value?.stageStatus).toBe("done");
      expect(stateResult.value?.artifacts.intake).toBe("authoring/intake.json");
    }
  });

  test("run() returns failed when the agent doesn't persist an artifact", async () => {
    const stage = new IntakeStage({ seedPrompt: "build auth" });
    const { platform } = makePlatform({ writeIntakeOnPrompt: undefined });
    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("ultraplan_intake_record");
  });

  test("run() is idempotent: a second run with an existing artifact skips", async () => {
    const stage = new IntakeStage({ seedPrompt: "build auth" });
    const { platform } = makePlatform({
      writeIntakeOnPrompt: {
        sessionId: SESSION_ID,
        title: "x",
        goal: "y",
        candidateStacks: [{ stack: "backend", applicability: "applicable" }],
      },
    });
    await stage.run(ctx(platform));

    const second = await stage.run(ctx(platform));
    expect(second.status).toBe("skipped");
  });

  test("run() returns failed when seed is empty even before spawning", async () => {
    const stage = new IntakeStage({ seedPrompt: "  " });
    const { platform, createAgentSession } = makePlatform();
    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(createAgentSession).toHaveBeenCalledTimes(0);
  });
});
