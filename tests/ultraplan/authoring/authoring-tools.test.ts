import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  ULTRAPLAN_AUTHORING_TOOL_NAMES,
  registerUltraPlanAuthoringPipelineTools,
} from "../../../src/ultraplan/authoring/authoring-tools.js";
import {
  getUltraplanAuthoringDecisionsPath,
  getUltraplanAuthoringDeferredIdeasPath,
  getUltraplanAuthoringDraftAuthoredJsonPath,
  getUltraplanAuthoringDraftFindingsPath,
  getUltraplanAuthoringDraftPlannerJsonPath,
  getUltraplanAuthoringIntakePath,
  getUltraplanAuthoringResearchStackPath,
  getUltraplanAuthoringResearchSummaryPath,
  getUltraplanAuthoringScoutPath,
} from "../../../src/ultraplan/project-paths.js";
import { saveUltraPlanManifest } from "../../../src/ultraplan/storage.js";
import { createTestPaths, createTestRepo, makeUltraPlanManifest } from "../fixtures.js";

const SESSION_ID = "up-author-tools-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;
let registered: Array<Record<string, unknown>>;

interface RegisteredTool {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal,
    onUpdate: unknown,
    toolCtx: unknown,
  ) => Promise<{ ok: boolean; message?: string; path?: string; details?: unknown }>;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-authoring-tools-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;
  saveUltraPlanManifest(paths, cwd, SESSION_ID, makeUltraPlanManifest({ sessionId: SESSION_ID }));
  registered = [];

  const platform: any = {
    paths,
    registerTool: mock((definition: Record<string, unknown>) => {
      registered.push(definition);
    }),
  };
  registerUltraPlanAuthoringPipelineTools(platform);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tool(name: string): RegisteredTool {
  const t = registered.find((r) => r.name === name);
  if (!t) throw new Error(`Tool ${name} was not registered`);
  return t as unknown as RegisteredTool;
}

const SIGNAL = new AbortController().signal;

describe("authoring tools — registration", () => {
  test("all 9 tools are registered with the harness", () => {
    expect(registered.length).toBe(ULTRAPLAN_AUTHORING_TOOL_NAMES.length);
    for (const name of ULTRAPLAN_AUTHORING_TOOL_NAMES) {
      expect(registered.find((r) => r.name === name)).toBeDefined();
    }
  });
});

describe("authoring tools — happy paths", () => {
  test("ultraplan_intake_record persists intake.json", async () => {
    const result = await tool("ultraplan_intake_record").execute(
      "id1",
      {
        sessionId: SESSION_ID,
        title: "Build auth",
        goal: "ship sign-in",
        candidateStacks: [{ stack: "backend", applicability: "applicable" }],
      },
      SIGNAL,
      undefined,
      { cwd },
    );
    expect(result.ok).toBe(true);
    expect(fs.existsSync(getUltraplanAuthoringIntakePath(paths, cwd, SESSION_ID))).toBe(true);
  });

  test("ultraplan_scout_record persists scout.json", async () => {
    const result = await tool("ultraplan_scout_record").execute(
      "id2",
      {
        sessionId: SESSION_ID,
        reusableAssets: [{ kind: "module", path: "src/auth.ts", note: "x" }],
      },
      SIGNAL,
      undefined,
      { cwd },
    );
    expect(result.ok).toBe(true);
    expect(fs.existsSync(getUltraplanAuthoringScoutPath(paths, cwd, SESSION_ID))).toBe(true);
  });

  test("ultraplan_decision_record appends one JSONL line", async () => {
    await tool("ultraplan_decision_record").execute(
      "id3",
      { sessionId: SESSION_ID, area: "auth", question: "Which?", decision: "JWT" },
      SIGNAL,
      undefined,
      { cwd },
    );
    await tool("ultraplan_decision_record").execute(
      "id4",
      { sessionId: SESSION_ID, area: "store", question: "Which?", decision: "Postgres" },
      SIGNAL,
      undefined,
      { cwd },
    );
    const filePath = getUltraplanAuthoringDecisionsPath(paths, cwd, SESSION_ID);
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
  });

  test("ultraplan_defer_idea appends to deferred-ideas.md (append-safe across calls)", async () => {
    await tool("ultraplan_defer_idea").execute(
      "id5",
      { sessionId: SESSION_ID, idea: "rate limiting" },
      SIGNAL,
      undefined,
      { cwd },
    );
    await tool("ultraplan_defer_idea").execute(
      "id6",
      { sessionId: SESSION_ID, idea: "metrics dashboard", reason: "post-MVP" },
      SIGNAL,
      undefined,
      { cwd },
    );
    const md = fs.readFileSync(getUltraplanAuthoringDeferredIdeasPath(paths, cwd, SESSION_ID), "utf8");
    expect(md.includes("rate limiting")).toBe(true);
    expect(md.includes("metrics dashboard")).toBe(true);
    expect(md.includes("post-MVP")).toBe(true);
  });

  test("ultraplan_research_record persists per-stack markdown", async () => {
    await tool("ultraplan_research_record").execute(
      "id7",
      { sessionId: SESSION_ID, stack: "backend", markdown: "# Backend research" },
      SIGNAL,
      undefined,
      { cwd },
    );
    expect(fs.existsSync(getUltraplanAuthoringResearchStackPath(paths, cwd, SESSION_ID, "backend"))).toBe(true);
  });

  test("ultraplan_research_summary persists SUMMARY.md", async () => {
    await tool("ultraplan_research_summary").execute(
      "id8",
      { sessionId: SESSION_ID, markdown: "# Summary" },
      SIGNAL,
      undefined,
      { cwd },
    );
    expect(fs.existsSync(getUltraplanAuthoringResearchSummaryPath(paths, cwd, SESSION_ID))).toBe(true);
  });

  test("ultraplan_synth_draft snapshots planner copy and writes editable copy", async () => {
    const draftAuthored = { sessionId: SESSION_ID, projectName: "p", title: "T" };
    await tool("ultraplan_synth_draft").execute(
      "id9",
      { sessionId: SESSION_ID, iteration: 1, authored: draftAuthored, manifest: {} },
      SIGNAL,
      undefined,
      { cwd },
    );
    expect(fs.existsSync(getUltraplanAuthoringDraftPlannerJsonPath(paths, cwd, SESSION_ID, 1))).toBe(true);
    expect(fs.existsSync(getUltraplanAuthoringDraftAuthoredJsonPath(paths, cwd, SESSION_ID, 1))).toBe(true);
  });

  test("ultraplan_review_finding accumulates findings across calls", async () => {
    const params = (id: string) => ({
      sessionId: SESSION_ID,
      iteration: 1,
      id,
      severity: "BLOCKER",
      source: "structure-checker",
      target: { stack: "backend", domainId: null, scenarioId: null },
      message: `msg ${id}`,
      recommendation: `rec ${id}`,
    });
    await tool("ultraplan_review_finding").execute("id10", params("f1"), SIGNAL, undefined, { cwd });
    await tool("ultraplan_review_finding").execute("id11", params("f2"), SIGNAL, undefined, { cwd });

    const filePath = getUltraplanAuthoringDraftFindingsPath(paths, cwd, SESSION_ID, 1);
    const artifact = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(artifact.findings.length).toBe(2);
  });

  test("ultraplan_revise_apply persists a new iteration", async () => {
    await tool("ultraplan_revise_apply").execute(
      "id12",
      { sessionId: SESSION_ID, iteration: 2, authored: { sessionId: SESSION_ID }, manifest: {} },
      SIGNAL,
      undefined,
      { cwd },
    );
    expect(fs.existsSync(getUltraplanAuthoringDraftAuthoredJsonPath(paths, cwd, SESSION_ID, 2))).toBe(true);
  });
});

describe("authoring tools — error paths", () => {
  test("missing cwd in tool context fails with a structured message", async () => {
    const result = await tool("ultraplan_intake_record").execute(
      "x",
      { sessionId: SESSION_ID, title: "x", goal: "y", candidateStacks: [] },
      SIGNAL,
      undefined,
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("cwd");
  });

  test("missing sessionId fails", async () => {
    const result = await tool("ultraplan_intake_record").execute(
      "x",
      { title: "x", goal: "y", candidateStacks: [] },
      SIGNAL,
      undefined,
      { cwd },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("sessionId");
  });

  test("ultraplan_synth_draft rejects iteration < 1", async () => {
    const result = await tool("ultraplan_synth_draft").execute(
      "x",
      { sessionId: SESSION_ID, iteration: 0, authored: {}, manifest: {} },
      SIGNAL,
      undefined,
      { cwd },
    );
    expect(result.ok).toBe(false);
  });

  test("ultraplan_revise_apply rejects iteration < 2", async () => {
    const result = await tool("ultraplan_revise_apply").execute(
      "x",
      { sessionId: SESSION_ID, iteration: 1, authored: {}, manifest: {} },
      SIGNAL,
      undefined,
      { cwd },
    );
    expect(result.ok).toBe(false);
  });

  test("ultraplan_research_record rejects unknown stack", async () => {
    const result = await tool("ultraplan_research_record").execute(
      "x",
      { sessionId: SESSION_ID, stack: "nope", markdown: "# x" },
      SIGNAL,
      undefined,
      { cwd },
    );
    expect(result.ok).toBe(false);
  });

  test("rejects unsafe sessionId values that could escape the session directory", async () => {
    const unsafe = ["../escape", "up-foo/../bar", "up-..-bad", "/abs", "C:\\nope", "", " ", "foo bar"];
    for (const sessionId of unsafe) {
      const result = await tool("ultraplan_intake_record").execute(
        "x",
        { sessionId, title: "t", goal: "g", candidateStacks: [] },
        SIGNAL,
        undefined,
        { cwd },
      );
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/sessionId/);
    }
  });
});
