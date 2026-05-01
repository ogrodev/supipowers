import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { SynthesizeStage } from "../../../../src/ultraplan/authoring/stages/synthesize.js";
import {
  getUltraplanAuthoringDraftAuthoredJsonPath,
} from "../../../../src/ultraplan/project-paths.js";
import { saveUltraPlanManifest } from "../../../../src/ultraplan/storage.js";
import {
  loadAuthoringState,
  saveDiscussArtifact,
  saveIntakeArtifact,
  saveResearchSummary,
  saveScoutArtifact,
} from "../../../../src/ultraplan/authoring/storage.js";
import type { ModelConfig } from "../../../../src/types.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanManifest,
} from "../../fixtures.js";

const SESSION_ID = "up-author-synthesize-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-synthesize-stage-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;
  saveUltraPlanManifest(paths, cwd, SESSION_ID, makeUltraPlanManifest({ sessionId: SESSION_ID }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = "2026-04-30T16:00:00.000Z";

interface FakePromptCall {
  text: string;
}

/** A minimal valid UltraPlanAuthoredArtifact for the given session. */
function makeValidDraft(sessionId: string) {
  return makeUltraPlanAuthored({ sessionId });
}

/** Seed all upstream artifacts so the stage reports isReady. */
function seedUpstreamArtifacts() {
  saveIntakeArtifact(paths, cwd, SESSION_ID, {
    sessionId: SESSION_ID,
    title: "Build auth",
    goal: "ship sign-in and sign-up",
    candidateStacks: [{ stack: "backend", applicability: "applicable" }],
  });
  saveScoutArtifact(paths, cwd, SESSION_ID, {
    sessionId: SESSION_ID,
    reusableAssets: [],
  });
  saveDiscussArtifact(paths, cwd, SESSION_ID, "Discussion notes about authentication.");
  saveResearchSummary(paths, cwd, SESSION_ID, "# Research Summary\n\nBest practices for auth.");
}

function makePlatform(opts: { writeDraftOnPrompt?: unknown } = {}) {
  const promptCalls: FakePromptCall[] = [];
  let disposed = 0;
  const session = {
    subscribe: mock(() => () => {}),
    state: { messages: [] as unknown[] },
    prompt: mock(async (text: string) => {
      promptCalls.push({ text });
      // Simulate the agent's `ultraplan_synth_draft` tool call by writing the draft artifact.
      if (opts.writeDraftOnPrompt !== undefined) {
        const draftPath = getUltraplanAuthoringDraftAuthoredJsonPath(paths, cwd, SESSION_ID, 1);
        fs.mkdirSync(path.dirname(draftPath), { recursive: true });
        fs.writeFileSync(draftPath, JSON.stringify(opts.writeDraftOnPrompt, null, 2));
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

describe("synthesize stage", () => {
  // -------------------------------------------------------------------------
  // isReady
  // -------------------------------------------------------------------------

  test("isReady false when all upstream artifacts are missing", async () => {
    const stage = new SynthesizeStage();
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("isReady false when only intake is present", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID });
    const stage = new SynthesizeStage();
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("isReady false when intake + scout present but discuss missing", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID });
    saveScoutArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID });
    const stage = new SynthesizeStage();
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("isReady false when intake + scout + discuss present but SUMMARY missing", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID });
    saveScoutArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID });
    saveDiscussArtifact(paths, cwd, SESSION_ID, "notes");
    const stage = new SynthesizeStage();
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("isReady true when all four upstream artifacts are present", async () => {
    seedUpstreamArtifacts();
    const stage = new SynthesizeStage();
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // isComplete
  // -------------------------------------------------------------------------

  test("isComplete false when no draft artifact", async () => {
    const stage = new SynthesizeStage();
    const { platform } = makePlatform();
    expect(await stage.isComplete(ctx(platform))).toBe(false);
  });

  test("isComplete false when draft exists but fails schema validation", async () => {
    const draftPath = getUltraplanAuthoringDraftAuthoredJsonPath(paths, cwd, SESSION_ID, 1);
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    fs.writeFileSync(draftPath, JSON.stringify({ bad: "object" }, null, 2));
    const stage = new SynthesizeStage();
    const { platform } = makePlatform();
    expect(await stage.isComplete(ctx(platform))).toBe(false);
  });

  test("isComplete true when a valid draft exists", async () => {
    const draftPath = getUltraplanAuthoringDraftAuthoredJsonPath(paths, cwd, SESSION_ID, 1);
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    fs.writeFileSync(draftPath, JSON.stringify(makeValidDraft(SESSION_ID), null, 2));
    const stage = new SynthesizeStage();
    const { platform } = makePlatform();
    expect(await stage.isComplete(ctx(platform))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // run — not-ready
  // -------------------------------------------------------------------------

  test("run() returns failed when upstream artifacts are missing, no agent spawned", async () => {
    const stage = new SynthesizeStage();
    const { platform, createAgentSession } = makePlatform();
    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("intake");
    expect(createAgentSession).toHaveBeenCalledTimes(0);
  });

  // -------------------------------------------------------------------------
  // run — agent embeds all four upstream artifacts
  // -------------------------------------------------------------------------

  test("run() embeds all four upstream artifacts in the prompt", async () => {
    seedUpstreamArtifacts();
    const stage = new SynthesizeStage();
    const { platform, promptCalls } = makePlatform({
      writeDraftOnPrompt: makeValidDraft(SESSION_ID),
    });

    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("awaiting-user");
    expect(promptCalls.length).toBe(1);

    const text = promptCalls[0]!.text;

    // All four artifact types are present in the assignment.
    expect(text.includes("\"sessionId\": \"up-author-synthesize-1\"")).toBe(true); // intake
    expect(text.includes("\"reusableAssets\"")).toBe(true);                        // scout
    expect(text.includes("Discussion notes about authentication.")).toBe(true);    // discuss
    expect(text.includes("Research Summary")).toBe(true);                          // SUMMARY

    // sessionId literal is embedded so the agent can reference it for the tool call.
    expect(text.includes(JSON.stringify(SESSION_ID))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // run — no draft persisted → failed
  // -------------------------------------------------------------------------

  test("run() returns failed when no draft is persisted by the agent", async () => {
    seedUpstreamArtifacts();
    const stage = new SynthesizeStage();
    const { platform } = makePlatform({ writeDraftOnPrompt: undefined });

    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("ultraplan_synth_draft");
  });

  // -------------------------------------------------------------------------
  // run — persisted draft fails schema validation → blocked
  // -------------------------------------------------------------------------

  test("run() returns blocked when the persisted draft fails schema validation", async () => {
    seedUpstreamArtifacts();
    const stage = new SynthesizeStage();
    const { platform } = makePlatform({
      // Missing all required fields — will fail validateUltraPlanAuthoredArtifact.
      writeDraftOnPrompt: { bad: "invalid-artifact" },
    });

    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("blocked");
    expect(result.blocker).toBeDefined();
    expect(result.blocker?.code).toBe("synth-draft-invalid");

    // The manifest should record the blocked status.
    const stateResult = loadAuthoringState(paths, cwd, SESSION_ID);
    expect(stateResult.ok).toBe(true);
    if (stateResult.ok) {
      expect(stateResult.value?.stageStatus).toBe("blocked");
      expect(stateResult.value?.blocker).not.toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // run — valid draft → awaiting-user
  // -------------------------------------------------------------------------

  test("run() returns awaiting-user on a valid draft", async () => {
    seedUpstreamArtifacts();
    const stage = new SynthesizeStage();
    const { platform, createAgentSession, promptCalls, getDisposeCount } = makePlatform({
      writeDraftOnPrompt: makeValidDraft(SESSION_ID),
    });

    const result = await stage.run(ctx(platform));

    expect(result.status).toBe("awaiting-user");
    expect(result.stage).toBe("synthesize");
    expect(result.artifactPaths).toContain("authoring/drafts/iteration-1/authored.json");

    // Exactly one agent session spawned, prompted, and disposed.
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(promptCalls.length).toBe(1);
    expect(getDisposeCount()).toBe(1);

    // Authoring state on the manifest reflects awaiting-user.
    const stateResult = loadAuthoringState(paths, cwd, SESSION_ID);
    expect(stateResult.ok).toBe(true);
    if (stateResult.ok) {
      expect(stateResult.value).not.toBeNull();
      expect(stateResult.value?.stage).toBe("synthesize");
      expect(stateResult.value?.stageStatus).toBe("awaiting-user");
      expect(stateResult.value?.artifacts.draft).toBe("authoring/drafts/iteration-1/authored.json");
      expect(stateResult.value?.blocker).toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // run — idempotent skip
  // -------------------------------------------------------------------------

  test("run() is idempotent: skips when iteration-1 draft already validates", async () => {
    seedUpstreamArtifacts();
    const stage = new SynthesizeStage();
    const { platform: p1 } = makePlatform({ writeDraftOnPrompt: makeValidDraft(SESSION_ID) });
    await stage.run(ctx(p1));

    // Second run with a fresh platform — should skip without spawning any agent.
    const { platform: p2, createAgentSession } = makePlatform();
    const second = await stage.run(ctx(p2));
    expect(second.status).toBe("skipped");
    expect(createAgentSession).toHaveBeenCalledTimes(0);
  });
});

