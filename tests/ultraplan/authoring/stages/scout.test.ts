import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ScoutStage } from "../../../../src/ultraplan/authoring/stages/scout.js";
import {
  getUltraplanAuthoringIntakePath,
  getUltraplanAuthoringScoutPath,
} from "../../../../src/ultraplan/project-paths.js";
import { saveUltraPlanManifest } from "../../../../src/ultraplan/storage.js";
import { saveIntakeArtifact } from "../../../../src/ultraplan/authoring/storage.js";
import type { ModelConfig } from "../../../../src/types.js";
import { createTestPaths, createTestRepo, makeUltraPlanManifest } from "../../fixtures.js";

const SESSION_ID = "up-author-scout-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-scout-stage-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;
  saveUltraPlanManifest(paths, cwd, SESSION_ID, makeUltraPlanManifest({ sessionId: SESSION_ID }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = "2026-04-30T15:30:00.000Z";

interface FakePromptCall {
  text: string;
}

function makePlatform(opts: { writeScoutOnPrompt?: unknown } = {}) {
  const promptCalls: FakePromptCall[] = [];
  const session = {
    subscribe: mock(() => () => {}),
    state: { messages: [] as unknown[] },
    prompt: mock(async (text: string) => {
      promptCalls.push({ text });
      if (opts.writeScoutOnPrompt) {
        const filePath = getUltraplanAuthoringScoutPath(paths, cwd, SESSION_ID);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(opts.writeScoutOnPrompt, null, 2));
      }
    }),
    dispose: mock(async () => {}),
  };
  const createAgentSession = mock(async () => session);
  const platform = {
    paths,
    createAgentSession,
    getModelForRole: mock(() => null),
    getCurrentModel: mock(() => "main-default"),
  };
  return { platform, session, createAgentSession, promptCalls };
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

describe("scout stage", () => {
  test("isReady false when intake is missing", async () => {
    const stage = new ScoutStage();
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("isReady true after intake exists", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID, title: "x" });
    const stage = new ScoutStage();
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(true);
    expect(fs.existsSync(getUltraplanAuthoringIntakePath(paths, cwd, SESSION_ID))).toBe(true);
  });

  test("run() returns failed when intake artifact missing", async () => {
    const stage = new ScoutStage();
    const { platform, createAgentSession } = makePlatform();
    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(createAgentSession).toHaveBeenCalledTimes(0);
  });

  test("run() spawns scout, embeds intake into the assignment, and persists artifact", async () => {
    const intake = {
      sessionId: SESSION_ID,
      title: "Build auth",
      goal: "ship",
      candidateStacks: [{ stack: "backend", applicability: "applicable" }],
    };
    saveIntakeArtifact(paths, cwd, SESSION_ID, intake);

    const scoutArtifact = {
      sessionId: SESSION_ID,
      reusableAssets: [{ kind: "module", path: "src/auth/jwt.ts", note: "JWT helper" }],
    };
    const stage = new ScoutStage();
    const { platform, createAgentSession, promptCalls } = makePlatform({ writeScoutOnPrompt: scoutArtifact });

    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("completed");
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(promptCalls.length).toBe(1);

    // Intake is embedded verbatim in the assignment.
    expect(promptCalls[0]!.text.includes("\"title\": \"Build auth\"")).toBe(true);
    expect(promptCalls[0]!.text.includes("\"goal\": \"ship\"")).toBe(true);

    // Scout artifact is persisted on disk.
    expect(fs.existsSync(getUltraplanAuthoringScoutPath(paths, cwd, SESSION_ID))).toBe(true);
  });

  test("run() returns failed when scout artifact never persisted", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID, title: "x" });
    const stage = new ScoutStage();
    const { platform } = makePlatform();
    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("ultraplan_scout_record");
  });

  test("run() is idempotent: a second run with existing scout skips", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID, title: "x" });
    const stage = new ScoutStage();
    const { platform } = makePlatform({ writeScoutOnPrompt: { sessionId: SESSION_ID } });
    await stage.run(ctx(platform));

    const second = await stage.run(ctx(platform));
    expect(second.status).toBe("skipped");
  });
});
