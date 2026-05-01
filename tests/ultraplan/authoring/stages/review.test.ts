import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ReviewStage } from "../../../../src/ultraplan/authoring/stages/review.js";
import {
  getUltraplanAuthoringDraftAuthoredJsonPath,
  getUltraplanAuthoringDraftFindingsPath,
} from "../../../../src/ultraplan/project-paths.js";
import { saveUltraPlanManifest } from "../../../../src/ultraplan/storage.js";
import {
  saveDraftAuthoredJson,
  saveFindingsArtifact,
  loadFindingsArtifact,
} from "../../../../src/ultraplan/authoring/storage.js";
import type { ModelConfig } from "../../../../src/types.js";
import { createTestPaths, createTestRepo, makeUltraPlanManifest } from "../../fixtures.js";

const SESSION_ID = "up-author-review-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-review-stage-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;
  // Seed manifest so saveAuthoringState has somewhere to land.
  saveUltraPlanManifest(paths, cwd, SESSION_ID, makeUltraPlanManifest({ sessionId: SESSION_ID }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = "2026-04-30T16:00:00.000Z";

const MODEL_CONFIG: ModelConfig = { version: "1", default: null, actions: {} };

// ---------------------------------------------------------------------------
// Platform factory
//
// Each call to `createAgentSession` returns a session whose `prompt` mock
// optionally simulates a checker calling `ultraplan_review_finding` by writing
// a findings artifact to disk directly.
// ---------------------------------------------------------------------------

interface FakePromptCall {
  text: string;
}

function makeValidFindingsArtifact(iteration: number) {
  return {
    iteration,
    draftRef: `drafts/iteration-${iteration}/authored.json`,
    recordedAt: NOW,
    findings: [
      {
        id: "struct-001",
        severity: "WARNING" as const,
        source: "structure-checker" as const,
        target: { stack: null, domainId: null, scenarioId: null },
        message: "Missing scenario level on one entry",
        recommendation: "Add level: unit to the scenario",
        recordedAt: NOW,
      },
    ],
  };
}

function makePlatform(
  opts: {
    /** If true, the first checker session writes a valid findings artifact on prompt. */
    writeCheckingFindingsOnFirstPrompt?: boolean;
    iteration?: number;
  } = {},
) {
  const promptCalls: FakePromptCall[] = [];
  let sessionCount = 0;
  const disposeCount = { value: 0 };

  const createAgentSession = mock(async () => {
    const sessionIndex = sessionCount++;
    const session = {
      subscribe: mock(() => () => {}),
      state: { messages: [] as unknown[] },
      prompt: mock(async (text: string) => {
        promptCalls.push({ text });
        // Simulate the first checker writing findings.
        if (opts.writeCheckingFindingsOnFirstPrompt && sessionIndex === 0) {
          const iteration = opts.iteration ?? 1;
          const artifact = makeValidFindingsArtifact(iteration);
          saveFindingsArtifact(paths, cwd, SESSION_ID, iteration, artifact);
        }
      }),
      dispose: mock(async () => {
        disposeCount.value += 1;
      }),
    };
    return session;
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
    promptCalls,
    getDisposeCount: () => disposeCount.value,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(platform: any) {
  return {
    platform,
    paths,
    cwd,
    sessionId: SESSION_ID,
    modelConfig: MODEL_CONFIG,
    now: () => NOW,
    modelOverride: { model: "test-model", thinkingLevel: null as string | null },
  };
}

function seedDraft(iteration: number, content: unknown = { title: "Draft", stacks: [] }) {
  saveDraftAuthoredJson(paths, cwd, SESSION_ID, iteration, content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("review stage", () => {
  // ---- isReady / isComplete --------------------------------------------------

  test("isReady returns false when no draft exists for the iteration", async () => {
    const stage = new ReviewStage({ iteration: 1 });
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("isReady returns true once draft authored.json exists for the iteration", async () => {
    seedDraft(1);
    const stage = new ReviewStage({ iteration: 1 });
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(true);
  });

  test("isComplete returns false when no findings.json exists", async () => {
    seedDraft(1);
    const stage = new ReviewStage({ iteration: 1 });
    const { platform } = makePlatform();
    expect(await stage.isComplete(ctx(platform))).toBe(false);
  });

  test("isComplete returns true when valid findings.json is present", async () => {
    seedDraft(1);
    saveFindingsArtifact(paths, cwd, SESSION_ID, 1, makeValidFindingsArtifact(1));
    const stage = new ReviewStage({ iteration: 1 });
    const { platform } = makePlatform();
    expect(await stage.isComplete(ctx(platform))).toBe(true);
  });

  // ---- not-ready guard -------------------------------------------------------

  test("run() returns failed when draft does not exist for the iteration", async () => {
    const stage = new ReviewStage({ iteration: 1 });
    const { platform, createAgentSession } = makePlatform();
    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("synthesize");
    expect(createAgentSession).toHaveBeenCalledTimes(0);
  });

  // ---- parallel agent spawn --------------------------------------------------

  test("run() spawns exactly 3 agent sessions in parallel", async () => {
    seedDraft(1);
    const stage = new ReviewStage({ iteration: 1 });
    const { platform, createAgentSession, promptCalls, getDisposeCount } = makePlatform();

    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("completed");
    expect(result.stage).toBe("review");
    expect(createAgentSession).toHaveBeenCalledTimes(3);
    expect(promptCalls.length).toBe(3);
    expect(getDisposeCount()).toBe(3);
  });

  // ---- zero-findings writes empty artifact -----------------------------------

  test("run() writes an empty findings.json when no checker calls the tool", async () => {
    seedDraft(1);
    const stage = new ReviewStage({ iteration: 1 });
    const { platform } = makePlatform();

    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("completed");

    // findings.json must exist and validate.
    const loaded = loadFindingsArtifact(paths, cwd, SESSION_ID, 1);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.findings).toEqual([]);
      expect(loaded.value.iteration).toBe(1);
      expect(loaded.value.draftRef).toBe("drafts/iteration-1/authored.json");
    }

    // isComplete should now return true.
    expect(await stage.isComplete(ctx(platform))).toBe(true);
  });

  // ---- preserves findings written by checkers --------------------------------

  test("run() preserves findings written by checker via simulated tool call", async () => {
    seedDraft(1);
    const stage = new ReviewStage({ iteration: 1 });
    const { platform } = makePlatform({
      writeCheckingFindingsOnFirstPrompt: true,
      iteration: 1,
    });

    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("completed");

    const loaded = loadFindingsArtifact(paths, cwd, SESSION_ID, 1);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.findings.length).toBe(1);
      expect(loaded.value.findings[0]!.id).toBe("struct-001");
      expect(loaded.value.findings[0]!.source).toBe("structure-checker");
    }
  });

  // ---- idempotent skip -------------------------------------------------------

  test("run() skips idempotently when findings.json already exists", async () => {
    seedDraft(1);
    saveFindingsArtifact(paths, cwd, SESSION_ID, 1, makeValidFindingsArtifact(1));

    const stage = new ReviewStage({ iteration: 1 });
    const { platform, createAgentSession } = makePlatform();

    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("skipped");
    expect(createAgentSession).toHaveBeenCalledTimes(0);
  });

  // ---- iteration=2 uses iteration-2 draft ------------------------------------

  test("iteration=2 checks readiness against iteration-2 draft, not iteration-1", async () => {
    // Only seed iteration-2 draft.
    seedDraft(2, { title: "Draft v2", stacks: [] });

    const stageV1 = new ReviewStage({ iteration: 1 });
    const stageV2 = new ReviewStage({ iteration: 2 });
    const { platform } = makePlatform({ iteration: 2 });

    // iteration-1 draft is absent → not ready.
    expect(await stageV1.isReady(ctx(platform))).toBe(false);
    // iteration-2 draft is present → ready.
    expect(await stageV2.isReady(ctx(platform))).toBe(true);

    // Running iteration-2 stage produces a findings.json under iteration-2 dir.
    const result = await stageV2.run(ctx(platform));
    expect(result.status).toBe("completed");

    const findingsPath2 = getUltraplanAuthoringDraftFindingsPath(paths, cwd, SESSION_ID, 2);
    expect(fs.existsSync(findingsPath2)).toBe(true);

    // iteration-1 findings must not have been created.
    const findingsPath1 = getUltraplanAuthoringDraftFindingsPath(paths, cwd, SESSION_ID, 1);
    expect(fs.existsSync(findingsPath1)).toBe(false);
  });

  // ---- assignment content checks ---------------------------------------------

  test("run() embeds the draft JSON in every checker assignment", async () => {
    const draftContent = { title: "My plan", stacks: [{ stack: "backend" }] };
    seedDraft(1, draftContent);
    const stage = new ReviewStage({ iteration: 1 });
    const { platform, promptCalls } = makePlatform();

    await stage.run(ctx(platform));

    // All three prompts must include the draft content.
    for (const call of promptCalls) {
      expect(call.text).toContain("My plan");
    }
  });

  test("run() sets stage to review with done status in authoring state after completion", async () => {
    seedDraft(1);
    const stage = new ReviewStage({ iteration: 1 });
    const { platform } = makePlatform();

    await stage.run(ctx(platform));

    // Manifest's authoring block must reflect the final state.
    const { loadAuthoringState } = await import(
      "../../../../src/ultraplan/authoring/storage.js"
    );
    const stateResult = loadAuthoringState(paths, cwd, SESSION_ID);
    expect(stateResult.ok).toBe(true);
    if (stateResult.ok) {
      expect(stateResult.value).not.toBeNull();
      expect(stateResult.value?.stage).toBe("review");
      expect(stateResult.value?.stageStatus).toBe("done");
      expect(stateResult.value?.iteration).toBe(1);
    }
  });
});
