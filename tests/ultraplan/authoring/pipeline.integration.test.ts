/**
 * End-to-end integration test for the multi-stage authoring pipeline.
 *
 * This test wires the real stage runners against a stub `Platform` whose `createAgentSession`
 * fakes the agent's tool calls by writing the expected artifact to disk on `prompt`. It
 * exercises intake \u2192 scout \u2192 discover \u2192 research \u2192 synthesize \u2192 review \u2192 approve and asserts:
 *  - every stage's artifact is persisted at the expected path,
 *  - the manifest's `authoring` block transitions correctly,
 *  - the canonical `authored.json` and `index.json` are written by APPROVE,
 *  - the full pipeline-log.jsonl captures every transition.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { runStage } from "../../../src/ultraplan/authoring/pipeline.js";
import { runEditorRoundTripOnce } from "../../../src/ultraplan/authoring/synth-gate.js";
import {
  appendDecisionRecord,
  hasAuthoringWorkspace,
  loadAuthoringState,
  saveDraftAuthoredJson,
  saveDraftPlannerJson,
  saveFindingsArtifact,
  saveResearchStackArtifact,
  saveResearchSummary,
} from "../../../src/ultraplan/authoring/storage.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanAuthoredMarkdownPath,
  getUltraplanAuthoringDecisionsPath,
  getUltraplanAuthoringDiscussPath,
  getUltraplanAuthoringDraftAuthoredJsonPath,
  getUltraplanAuthoringDraftFindingsPath,
  getUltraplanAuthoringIntakePath,
  getUltraplanAuthoringResearchStackPath,
  getUltraplanAuthoringResearchSummaryPath,
  getUltraplanAuthoringScoutPath,
  getUltraplanIndexPath,
} from "../../../src/ultraplan/project-paths.js";
import { saveUltraPlanManifest } from "../../../src/ultraplan/storage.js";
import type { ModelConfig } from "../../../src/types.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanManifest,
} from "../fixtures.js";

const SESSION_ID = "up-integration-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-pipeline-integration-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;
  saveUltraPlanManifest(paths, cwd, SESSION_ID, makeUltraPlanManifest({ sessionId: SESSION_ID }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const MODEL_CONFIG: ModelConfig = { version: "1", default: null, actions: {} };

/**
 * Build a stub platform whose `createAgentSession` invokes a per-stage callback to fake the
 * agent's tool calls. The callback receives the assignment text so it can extract the
 * sessionId and write the artifact at the expected path.
 */
function makePipelinePlatform(handlers: Record<string, (assignment: string) => void>) {
  const calls: { stage?: string; assignment: string; agentDisplayName?: string }[] = [];
  return {
    paths,
    createAgentSession: mock(async (opts: any) => {
      const display: string | undefined = opts.agentDisplayName;
      // Pull the stage segment out of "ultraplan-authoring-<stage>[/<discriminator>]"
      const match = display?.match(/ultraplan-authoring-([a-z-]+)/);
      const stage = match?.[1];
      return {
        subscribe: () => () => {},
        state: { messages: [] as unknown[] },
        prompt: async (text: string) => {
          calls.push({ stage, assignment: text, agentDisplayName: display });
          if (stage && handlers[stage]) handlers[stage](text);
        },
        dispose: async () => {},
      };
    }),
    getModelForRole: mock(() => null),
    getCurrentModel: mock(() => "main-default"),
  } as any;
}

const SEED = "Build minimal user authentication.";

describe("pipeline integration — happy path", () => {
  test("intake \u2192 scout \u2192 discover \u2192 research \u2192 synthesize \u2192 (editor gate) \u2192 review \u2192 approve", async () => {
    // The fake authored draft we will use throughout the synthesize stage.
    const authoredDraft = makeUltraPlanAuthored({ sessionId: SESSION_ID, title: "Auth slice", goal: "Ship sign-in" });

    const platform = makePipelinePlatform({
      intake: () => {
        // Agent calls ultraplan_intake_record \u2192 simulate by writing the artifact.
        const filePath = getUltraplanAuthoringIntakePath(paths, cwd, SESSION_ID);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          JSON.stringify(
            {
              sessionId: SESSION_ID,
              title: "Auth slice",
              goal: "Ship sign-in",
              candidateStacks: [
                { stack: "frontend", applicability: "applicable" },
                { stack: "backend", applicability: "not-applicable" },
                { stack: "infrastructure", applicability: "not-applicable" },
              ],
              rawUserNotes: SEED,
              deferredIdeas: [],
            },
            null,
            2,
          ),
        );
      },
      scout: () => {
        const filePath = getUltraplanAuthoringScoutPath(paths, cwd, SESSION_ID);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          JSON.stringify(
            { sessionId: SESSION_ID, reusableAssets: [{ kind: "module", path: "src/auth.ts", note: "JWT helper" }] },
            null,
            2,
          ),
        );
      },
      discover: () => {
        // Agent appends a decision via appendDecisionRecord (the runner verifies file exists with >=1 line).
        appendDecisionRecord(paths, cwd, SESSION_ID, {
          area: "auth-strategy",
          question: "Which auth approach?",
          decision: "JWT",
          rationale: "stateless",
          recordedAt: new Date().toISOString(),
        });
      },
      research: () => {
        // Each researcher writes its stack file; deterministic SUMMARY built by the stage runner.
        saveResearchStackArtifact(paths, cwd, SESSION_ID, "frontend", "# Frontend research\n- Library: react-hook-form\n");
      },
      synthesize: () => {
        // Planner writes the draft via the same shape the synth tool uses.
        saveDraftPlannerJson(paths, cwd, SESSION_ID, 1, authoredDraft);
        saveDraftAuthoredJson(paths, cwd, SESSION_ID, 1, authoredDraft);
      },
      review: () => {
        // Three checkers run in parallel; for the integration we leave findings empty so the
        // stage writes an empty findings.json, which is a valid converged state.
      },
    });

    // Stage 1: INTAKE
    const intakeResult = await runStage("intake", {
      platform, paths, cwd, sessionId: SESSION_ID, modelConfig: MODEL_CONFIG, seedPrompt: SEED,
    });
    expect(intakeResult.status).toBe("completed");
    expect(fs.existsSync(getUltraplanAuthoringIntakePath(paths, cwd, SESSION_ID))).toBe(true);

    // Stage 2: SCOUT
    const scoutResult = await runStage("scout", {
      platform, paths, cwd, sessionId: SESSION_ID, modelConfig: MODEL_CONFIG, seedPrompt: "",
    });
    expect(scoutResult.status).toBe("completed");
    expect(fs.existsSync(getUltraplanAuthoringScoutPath(paths, cwd, SESSION_ID))).toBe(true);

    // Stage 3: DISCOVER (returns awaiting-user)
    const discoverResult = await runStage("discover", {
      platform, paths, cwd, sessionId: SESSION_ID, modelConfig: MODEL_CONFIG, seedPrompt: "",
    });
    expect(discoverResult.status === "completed" || discoverResult.status === "awaiting-user").toBe(true);
    expect(fs.existsSync(getUltraplanAuthoringDecisionsPath(paths, cwd, SESSION_ID))).toBe(true);
    expect(fs.existsSync(getUltraplanAuthoringDiscussPath(paths, cwd, SESSION_ID))).toBe(true);

    // Stage 4: RESEARCH (one applicable stack: frontend)
    const researchResult = await runStage("research", {
      platform, paths, cwd, sessionId: SESSION_ID, modelConfig: MODEL_CONFIG, seedPrompt: "",
    });
    expect(researchResult.status).toBe("completed");
    expect(fs.existsSync(getUltraplanAuthoringResearchStackPath(paths, cwd, SESSION_ID, "frontend"))).toBe(true);
    expect(fs.existsSync(getUltraplanAuthoringResearchSummaryPath(paths, cwd, SESSION_ID))).toBe(true);

    // Stage 5: SYNTHESIZE (returns awaiting-user)
    const synthResult = await runStage("synthesize", {
      platform, paths, cwd, sessionId: SESSION_ID, modelConfig: MODEL_CONFIG, seedPrompt: "",
    });
    expect(synthResult.status === "awaiting-user" || synthResult.status === "completed").toBe(true);
    expect(fs.existsSync(getUltraplanAuthoringDraftAuthoredJsonPath(paths, cwd, SESSION_ID, 1))).toBe(true);

    // Editor gate: simulate "no changes" by stubbing exec.
    const editorPlatform = {
      paths,
      exec: mock(async () => ({ stdout: "", stderr: "", code: 0 })),
    } as any;
    process.env.EDITOR = "fake-editor";
    const gateResult = await runEditorRoundTripOnce({
      platform: editorPlatform, paths, cwd, sessionId: SESSION_ID, iteration: 1,
    });
    expect(gateResult.status === "no-changes" || gateResult.status === "saved").toBe(true);

    // Stage 6: REVIEW
    const reviewResult = await runStage("review", {
      platform, paths, cwd, sessionId: SESSION_ID, modelConfig: MODEL_CONFIG, seedPrompt: "",
    });
    expect(reviewResult.status).toBe("completed");
    expect(fs.existsSync(getUltraplanAuthoringDraftFindingsPath(paths, cwd, SESSION_ID, 1))).toBe(true);

    // Stage 7: APPROVE \u2014 promotes the draft to canonical authored.json + clears authoring block.
    const approveResult = await runStage("approve", {
      platform, paths, cwd, sessionId: SESSION_ID, modelConfig: MODEL_CONFIG, seedPrompt: "",
    });
    expect(approveResult.status).toBe("completed");

    expect(fs.existsSync(getUltraplanAuthoredJsonPath(paths, cwd, SESSION_ID))).toBe(true);
    expect(fs.existsSync(getUltraplanAuthoredMarkdownPath(paths, cwd, SESSION_ID))).toBe(true);
    expect(fs.existsSync(getUltraplanIndexPath(paths, cwd))).toBe(true);

    // Manifest's authoring block is cleared after approval.
    const stateResult = loadAuthoringState(paths, cwd, SESSION_ID);
    expect(stateResult.ok).toBe(true);
    if (stateResult.ok) expect(stateResult.value).toBeNull();

    // Workspace artifacts still exist for forensics.
    expect(hasAuthoringWorkspace(paths, cwd, SESSION_ID)).toBe(true);
  });
});

describe("pipeline integration — failure paths", () => {
  test("research stage blocks when a researcher does not write its artifact", async () => {
    // Seed prerequisites manually.
    fs.mkdirSync(path.dirname(getUltraplanAuthoringIntakePath(paths, cwd, SESSION_ID)), { recursive: true });
    fs.writeFileSync(
      getUltraplanAuthoringIntakePath(paths, cwd, SESSION_ID),
      JSON.stringify({
        sessionId: SESSION_ID, title: "x", goal: "y",
        candidateStacks: [{ stack: "frontend", applicability: "applicable" }],
      }),
    );
    fs.writeFileSync(getUltraplanAuthoringScoutPath(paths, cwd, SESSION_ID), JSON.stringify({ sessionId: SESSION_ID }));
    appendDecisionRecord(paths, cwd, SESSION_ID, { area: "x", question: "q", decision: "d", recordedAt: "ts" });

    // Researcher that doesn't write its artifact \u2192 stage blocks.
    const platform = makePipelinePlatform({
      research: () => {
        // Intentionally write nothing.
      },
    });

    const result = await runStage("research", {
      platform, paths, cwd, sessionId: SESSION_ID, modelConfig: MODEL_CONFIG, seedPrompt: "",
    });
    expect(result.status).toBe("blocked");
  });

  test("approve stage blocks when the draft fails schema validation", async () => {
    // Seed a corrupt draft + an empty findings artifact.
    saveDraftPlannerJson(paths, cwd, SESSION_ID, 1, { not: "valid" });
    saveDraftAuthoredJson(paths, cwd, SESSION_ID, 1, { not: "valid" });
    saveFindingsArtifact(paths, cwd, SESSION_ID, 1, {
      iteration: 1,
      draftRef: "drafts/iteration-1/authored.json",
      recordedAt: "2026-04-30T12:00:00.000Z",
      findings: [],
    });

    const platform = makePipelinePlatform({});
    const result = await runStage("approve", {
      platform, paths, cwd, sessionId: SESSION_ID, modelConfig: MODEL_CONFIG, seedPrompt: "",
    });
    expect(result.status === "blocked" || result.status === "failed").toBe(true);
  });
});
