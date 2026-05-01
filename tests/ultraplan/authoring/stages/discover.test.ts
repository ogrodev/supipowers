import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { DiscoverStage } from "../../../../src/ultraplan/authoring/stages/discover.js";
import {
  getUltraplanAuthoringDecisionsPath,
  getUltraplanAuthoringDiscussPath,
  getUltraplanAuthoringIntakePath,
  getUltraplanAuthoringScoutPath,
} from "../../../../src/ultraplan/project-paths.js";
import { saveUltraPlanManifest } from "../../../../src/ultraplan/storage.js";
import {
  loadAuthoringState,
  saveIntakeArtifact,
  saveScoutArtifact,
} from "../../../../src/ultraplan/authoring/storage.js";
import type { ModelConfig } from "../../../../src/types.js";
import { createTestPaths, createTestRepo, makeUltraPlanManifest } from "../../fixtures.js";

const SESSION_ID = "up-author-discover-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-discover-stage-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;
  saveUltraPlanManifest(paths, cwd, SESSION_ID, makeUltraPlanManifest({ sessionId: SESSION_ID }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = "2026-04-30T15:45:00.000Z";

interface FakePromptCall {
  text: string;
}

function makeDecisionLine(
  area: string,
  question: string,
  decision: string,
  rationale?: string,
  impact?: string[],
): string {
  const record: Record<string, unknown> = {
    sessionId: SESSION_ID,
    area,
    question,
    decision,
    recordedAt: NOW,
  };
  if (rationale) record.rationale = rationale;
  if (impact) record.impact = impact;
  return JSON.stringify(record);
}

function writeDecisions(lines: string[]): void {
  const decisionsPath = getUltraplanAuthoringDecisionsPath(paths, cwd, SESSION_ID);
  fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });
  fs.writeFileSync(decisionsPath, lines.join("\n") + "\n");
}

function makePlatform(opts: { writeDecisionsOnPrompt?: string[] } = {}) {
  const promptCalls: FakePromptCall[] = [];
  const session = {
    subscribe: mock(() => () => {}),
    state: { messages: [] as unknown[] },
    prompt: mock(async (text: string) => {
      promptCalls.push({ text });
      if (opts.writeDecisionsOnPrompt) {
        writeDecisions(opts.writeDecisionsOnPrompt);
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

describe("discover stage", () => {
  test("isReady false when both intake and scout are missing", async () => {
    const stage = new DiscoverStage();
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("isReady false when only intake exists (scout missing)", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID, title: "x" });
    const stage = new DiscoverStage();
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("isReady false when only scout exists (intake missing)", async () => {
    saveScoutArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID });
    const stage = new DiscoverStage();
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(false);
  });

  test("isReady true when both intake and scout exist", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID, title: "x" });
    saveScoutArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID });
    const stage = new DiscoverStage();
    const { platform } = makePlatform();
    expect(await stage.isReady(ctx(platform))).toBe(true);
    expect(fs.existsSync(getUltraplanAuthoringIntakePath(paths, cwd, SESSION_ID))).toBe(true);
    expect(fs.existsSync(getUltraplanAuthoringScoutPath(paths, cwd, SESSION_ID))).toBe(true);
  });

  test("isComplete false when decisions.jsonl is missing", async () => {
    const stage = new DiscoverStage();
    const { platform } = makePlatform();
    expect(await stage.isComplete(ctx(platform))).toBe(false);
  });

  test("isComplete false when decisions.jsonl is empty", async () => {
    const decisionsPath = getUltraplanAuthoringDecisionsPath(paths, cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });
    fs.writeFileSync(decisionsPath, "\n\n");
    const stage = new DiscoverStage();
    const { platform } = makePlatform();
    expect(await stage.isComplete(ctx(platform))).toBe(false);
  });

  test("isComplete true when decisions.jsonl has at least one non-empty line", async () => {
    writeDecisions([makeDecisionLine("auth", "Which strategy?", "JWT")]);
    const stage = new DiscoverStage();
    const { platform } = makePlatform();
    expect(await stage.isComplete(ctx(platform))).toBe(true);
  });

  test("run() returns failed when intake is missing", async () => {
    const stage = new DiscoverStage();
    const { platform, createAgentSession } = makePlatform();
    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(createAgentSession).toHaveBeenCalledTimes(0);
  });

  test("run() returns failed when scout is missing (intake present)", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID, title: "x" });
    const stage = new DiscoverStage();
    const { platform, createAgentSession } = makePlatform();
    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(createAgentSession).toHaveBeenCalledTimes(0);
  });

  test("run() returns failed when agent never calls ultraplan_decision_record", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID, title: "x" });
    saveScoutArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID });
    const stage = new DiscoverStage();
    const { platform } = makePlatform();
    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("ultraplan_decision_record");
  });

  test("run() returns awaiting-user when decisions are written and embeds intake + scout into the prompt", async () => {
    const intake = {
      sessionId: SESSION_ID,
      title: "Build auth",
      goal: "ship",
      candidateStacks: [{ stack: "backend", applicability: "applicable" }],
    };
    const scout = {
      sessionId: SESSION_ID,
      reusableAssets: [{ kind: "module", path: "src/auth/jwt.ts", note: "JWT helper" }],
    };
    saveIntakeArtifact(paths, cwd, SESSION_ID, intake);
    saveScoutArtifact(paths, cwd, SESSION_ID, scout);

    const decisionLines = [
      makeDecisionLine("auth-strategy", "Which auth strategy?", "JWT", "Simplest token model", ["backend"]),
    ];
    const stage = new DiscoverStage();
    const { platform, createAgentSession, promptCalls } = makePlatform({ writeDecisionsOnPrompt: decisionLines });

    const result = await stage.run(ctx(platform));
    expect(result.status).toBe("awaiting-user");
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(promptCalls.length).toBe(1);

    // Both artifacts are embedded verbatim in the assignment prompt.
    expect(promptCalls[0]!.text.includes("\"title\": \"Build auth\"")).toBe(true);
    expect(promptCalls[0]!.text.includes("\"goal\": \"ship\"")).toBe(true);
    expect(promptCalls[0]!.text.includes("\"path\": \"src/auth/jwt.ts\"")).toBe(true);

    // decisions.jsonl is on disk.
    expect(fs.existsSync(getUltraplanAuthoringDecisionsPath(paths, cwd, SESSION_ID))).toBe(true);

    // discuss.md is produced.
    expect(fs.existsSync(getUltraplanAuthoringDiscussPath(paths, cwd, SESSION_ID))).toBe(true);

    // Authoring state reflects awaiting-user.
    const stateResult = loadAuthoringState(paths, cwd, SESSION_ID);
    expect(stateResult.ok).toBe(true);
    if (stateResult.ok) {
      expect(stateResult.value).not.toBeNull();
      expect(stateResult.value?.stage).toBe("discover");
      expect(stateResult.value?.stageStatus).toBe("awaiting-user");
      expect(stateResult.value?.artifacts.discuss).toBe("authoring/discuss.md");
    }

    // Result details include decisionCount.
    expect(result.details?.decisionCount).toBe(1);
  });

  test("run() is idempotent: a second run with existing decisions.jsonl returns skipped", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID, title: "x" });
    saveScoutArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID });
    const decisionLines = [makeDecisionLine("scope", "In scope?", "Yes")];
    const stage = new DiscoverStage();
    const { platform } = makePlatform({ writeDecisionsOnPrompt: decisionLines });
    await stage.run(ctx(platform));

    const second = await stage.run(ctx(platform));
    expect(second.status).toBe("skipped");
  });

  test("discuss.md round-trips all decision fields from JSONL", async () => {
    saveIntakeArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID, title: "x" });
    saveScoutArtifact(paths, cwd, SESSION_ID, { sessionId: SESSION_ID });

    const decisionLines = [
      makeDecisionLine("auth", "JWT or session?", "JWT", "Simpler for mobile", ["backend", "frontend"]),
      makeDecisionLine("storage", "Postgres or SQLite?", "Postgres"),
    ];
    const stage = new DiscoverStage();
    const { platform } = makePlatform({ writeDecisionsOnPrompt: decisionLines });
    await stage.run(ctx(platform));

    const discussPath = getUltraplanAuthoringDiscussPath(paths, cwd, SESSION_ID);
    expect(fs.existsSync(discussPath)).toBe(true);
    const content = fs.readFileSync(discussPath, "utf8");

    // Heading
    expect(content.includes("# Decisions")).toBe(true);

    // First decision: all fields rendered
    expect(content.includes("## auth")).toBe(true);
    expect(content.includes("Q: JWT or session?")).toBe(true);
    expect(content.includes("A: JWT")).toBe(true);
    expect(content.includes("Rationale: Simpler for mobile")).toBe(true);
    expect(content.includes("Impact: backend, frontend")).toBe(true);

    // Second decision: no rationale/impact
    expect(content.includes("## storage")).toBe(true);
    expect(content.includes("Q: Postgres or SQLite?")).toBe(true);
    expect(content.includes("A: Postgres")).toBe(true);
  });
});
