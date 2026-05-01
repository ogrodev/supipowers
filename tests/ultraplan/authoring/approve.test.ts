import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ApproveStage } from "../../../src/ultraplan/authoring/stages/approve.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanAuthoredMarkdownPath,
  getUltraplanAuthoringDraftAuthoredJsonPath,
  getUltraplanAuthoringDraftFindingsPath,
  getUltraplanIndexPath,
} from "../../../src/ultraplan/project-paths.js";
import { loadUltraPlanManifest, saveUltraPlanManifest } from "../../../src/ultraplan/storage.js";
import {
  saveDraftAuthoredJson,
  saveFindingsArtifact,
} from "../../../src/ultraplan/authoring/storage.js";
import type { ModelConfig, UltraPlanAuthoringState } from "../../../src/types.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanManifest,
} from "../fixtures.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SESSION_ID = "up-author-approve-1";
const ITERATION = 1;
const NOW = "2026-04-30T16:00:00.000Z";
const MODEL_CONFIG: ModelConfig = { version: "1", default: null, actions: {} };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

const AUTHORING_STATE: UltraPlanAuthoringState = {
  pipeline: "multi-stage",
  stage: "approve",
  stageStatus: "awaiting-user",
  iteration: ITERATION,
  stallReentryCount: 0,
  artifacts: {},
  blocker: null,
  startedAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-approve-stage-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;
  // Seed a manifest that represents an in-flight authoring session.
  saveUltraPlanManifest(
    paths,
    cwd,
    SESSION_ID,
    makeUltraPlanManifest({
      sessionId: SESSION_ID,
      state: "awaiting-user",
      authoring: AUTHORING_STATE,
    }),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Minimal platform stub (approve stage never spawns an agent)
// ---------------------------------------------------------------------------

function makePlatform() {
  return { paths, createAgentSession: () => { throw new Error("Should not spawn agent"); } };
}

function ctx(platform: any = makePlatform()) {
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

// ---------------------------------------------------------------------------
// Helpers to seed draft artifacts
// ---------------------------------------------------------------------------

function seedDraftAuthored(iteration = ITERATION): void {
  const artifact = makeUltraPlanAuthored({ sessionId: SESSION_ID });
  const result = saveDraftAuthoredJson(paths, cwd, SESSION_ID, iteration, artifact);
  if (!result.ok) throw new Error(`Failed to seed draft authored.json: ${result.error.message}`);
}

function seedFindings(iteration = ITERATION): void {
  const findings = {
    iteration,
    draftRef: `authoring/drafts/iteration-${iteration}/authored.json`,
    recordedAt: NOW,
    findings: [],
  };
  const result = saveFindingsArtifact(paths, cwd, SESSION_ID, iteration, findings);
  if (!result.ok) throw new Error(`Failed to seed findings.json: ${result.error.message}`);
}

// ---------------------------------------------------------------------------
// isReady
// ---------------------------------------------------------------------------

describe("approve stage — isReady", () => {
  test("false when both draft and findings are missing", async () => {
    const stage = new ApproveStage({ iteration: ITERATION });
    expect(await stage.isReady(ctx())).toBe(false);
  });

  test("false when draft exists but findings is missing", async () => {
    seedDraftAuthored();
    const stage = new ApproveStage({ iteration: ITERATION });
    expect(await stage.isReady(ctx())).toBe(false);
  });

  test("false when findings exists but draft is missing", async () => {
    seedFindings();
    const stage = new ApproveStage({ iteration: ITERATION });
    expect(await stage.isReady(ctx())).toBe(false);
  });

  test("true when both draft authored.json and findings.json exist", async () => {
    seedDraftAuthored();
    seedFindings();
    const stage = new ApproveStage({ iteration: ITERATION });
    expect(await stage.isReady(ctx())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isComplete
// ---------------------------------------------------------------------------

describe("approve stage — isComplete", () => {
  test("false when canonical authored.json is missing", async () => {
    const stage = new ApproveStage({ iteration: ITERATION });
    expect(await stage.isComplete(ctx())).toBe(false);
  });

  test("false when canonical authored.json exists but manifest has authoring block", async () => {
    // Write canonical authored.json but leave authoring block on manifest.
    const authoredPath = getUltraplanAuthoredJsonPath(paths, cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(authoredPath), { recursive: true });
    fs.writeFileSync(authoredPath, JSON.stringify(makeUltraPlanAuthored({ sessionId: SESSION_ID })));

    const stage = new ApproveStage({ iteration: ITERATION });
    // Manifest still has authoring block (set in beforeEach).
    expect(await stage.isComplete(ctx())).toBe(false);
  });

  test("true when canonical authored.json exists and manifest has no authoring block", async () => {
    // Write canonical authored.json.
    const authoredPath = getUltraplanAuthoredJsonPath(paths, cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(authoredPath), { recursive: true });
    fs.writeFileSync(authoredPath, JSON.stringify(makeUltraPlanAuthored({ sessionId: SESSION_ID })));

    // Overwrite manifest without authoring block.
    saveUltraPlanManifest(
      paths, cwd, SESSION_ID,
      makeUltraPlanManifest({ sessionId: SESSION_ID, state: "ready" }),
    );

    const stage = new ApproveStage({ iteration: ITERATION });
    expect(await stage.isComplete(ctx())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// run() — not-ready guards
// ---------------------------------------------------------------------------

describe("approve stage — run() not-ready guards", () => {
  test("returns failed when draft authored.json is missing", async () => {
    const stage = new ApproveStage({ iteration: ITERATION });
    const result = await stage.run(ctx());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("draft authored.json");
    expect(result.error).toContain(`iteration ${ITERATION}`);
  });

  test("returns failed when findings.json is missing (draft exists)", async () => {
    seedDraftAuthored();
    const stage = new ApproveStage({ iteration: ITERATION });
    const result = await stage.run(ctx());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("findings.json");
    expect(result.error).toContain(`iteration ${ITERATION}`);
  });
});

// ---------------------------------------------------------------------------
// run() — corrupt draft returns blocked
// ---------------------------------------------------------------------------

describe("approve stage — run() corrupt draft", () => {
  test("returns blocked when draft authored.json fails schema validation", async () => {
    seedFindings();

    // Write a corrupt draft (invalid sessionId type, missing required fields).
    const draftPath = getUltraplanAuthoringDraftAuthoredJsonPath(paths, cwd, SESSION_ID, ITERATION);
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    fs.writeFileSync(draftPath, JSON.stringify({ sessionId: 42, broken: true }));

    const stage = new ApproveStage({ iteration: ITERATION });
    const result = await stage.run(ctx());
    expect(result.status).toBe("blocked");
    expect(result.error).toContain("schema validation");
  });
});

// ---------------------------------------------------------------------------
// run() — happy path
// ---------------------------------------------------------------------------

describe("approve stage — run() happy path", () => {
  test("promotes draft to canonical authored.json", async () => {
    seedDraftAuthored();
    seedFindings();

    const stage = new ApproveStage({ iteration: ITERATION });
    const result = await stage.run(ctx());

    expect(result.status).toBe("completed");
    expect(result.stage).toBe("approve");

    const authoredPath = getUltraplanAuthoredJsonPath(paths, cwd, SESSION_ID);
    expect(fs.existsSync(authoredPath)).toBe(true);
    const authored = JSON.parse(fs.readFileSync(authoredPath, "utf8"));
    expect(authored.sessionId).toBe(SESSION_ID);
  });

  test("clears the manifest authoring block after promotion", async () => {
    seedDraftAuthored();
    seedFindings();

    const stage = new ApproveStage({ iteration: ITERATION });
    await stage.run(ctx());

    const manifestResult = loadUltraPlanManifest(paths, cwd, SESSION_ID);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    expect(manifestResult.value.authoring).toBeUndefined();
    expect(manifestResult.value.state).toBe("ready");
  });

  test("updates index.json with the promoted session entry", async () => {
    seedDraftAuthored();
    seedFindings();

    const stage = new ApproveStage({ iteration: ITERATION });
    await stage.run(ctx());

    const indexPath = getUltraplanIndexPath(paths, cwd);
    expect(fs.existsSync(indexPath)).toBe(true);
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const entry = index.sessions.find((s: { sessionId: string }) => s.sessionId === SESSION_ID);
    expect(entry).toBeDefined();
    expect(entry.state).toBe("ready");
  });

  test("writes authored.md to the canonical session directory", async () => {
    seedDraftAuthored();
    seedFindings();

    const stage = new ApproveStage({ iteration: ITERATION });
    await stage.run(ctx());

    const mdPath = getUltraplanAuthoredMarkdownPath(paths, cwd, SESSION_ID);
    expect(fs.existsSync(mdPath)).toBe(true);
    const md = fs.readFileSync(mdPath, "utf8");
    // Should contain the title from makeUltraPlanAuthored
    expect(md).toContain("Auth slice");
    expect(md).toContain("Ship authentication");
  });

  test("appends a pipeline-log entry summarising the promotion", async () => {
    seedDraftAuthored();
    seedFindings();

    const stage = new ApproveStage({ iteration: ITERATION });
    await stage.run(ctx());

    // Verify pipeline-log.jsonl was written and contains the approve entry.
    const { getUltraplanAuthoringPipelineLogPath } = await import(
      "../../../src/ultraplan/project-paths.js"
    );
    const logPath = getUltraplanAuthoringPipelineLogPath(paths, cwd, SESSION_ID);
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    const approveEvent = events.find((e: { stage: string }) => e.stage === "approve");
    expect(approveEvent).toBeDefined();
    expect(approveEvent.summary).toContain(SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// run() — idempotent skip
// ---------------------------------------------------------------------------

describe("approve stage — run() idempotent skip", () => {
  test("returns skipped when canonical authored.json exists and authoring block is cleared", async () => {
    // Simulate a completed promotion: write authored.json + manifest without authoring block.
    const authoredPath = getUltraplanAuthoredJsonPath(paths, cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(authoredPath), { recursive: true });
    fs.writeFileSync(
      authoredPath,
      JSON.stringify(makeUltraPlanAuthored({ sessionId: SESSION_ID })),
    );
    saveUltraPlanManifest(
      paths, cwd, SESSION_ID,
      makeUltraPlanManifest({ sessionId: SESSION_ID, state: "ready" }),
    );

    // Put draft + findings in place so isReady passes (isComplete takes priority in run).
    seedDraftAuthored();
    seedFindings();

    const stage = new ApproveStage({ iteration: ITERATION });
    const result = await stage.run(ctx());
    expect(result.status).toBe("skipped");
    expect(result.artifactPaths).toContain("authored.json");
  });
});
