import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildHarnessRunner,
  HARNESS_STAGE_ORDER,
  runHarnessPipelineUntilGate,
  type PipelineDriverInput,
  type HarnessPipelineProgressEvent,
} from "../../src/harness/pipeline.js";
import { newHarnessSessionId } from "../../src/harness/stage-runner.js";
import {
  saveHarnessDiscover,
  saveHarnessSession,
} from "../../src/harness/storage.js";
import { savePlan } from "../../src/storage/plans.js";
import { createTestPaths, createTestRepo } from "../ultraplan/fixtures.js";
import type { Platform } from "../../src/platform/types.js";
import type { HarnessSession, ModelConfig } from "../../src/types.js";

describe("harness pipeline", () => {
  test("stage order matches the contract", () => {
    expect(HARNESS_STAGE_ORDER).toEqual([
      "discover",
      "research",
      "design",
      "plan",
      "implement",
      "validate",
    ]);
  });

  test("buildHarnessRunner constructs each stage", () => {
    const discover = buildHarnessRunner("discover", {});
    expect(discover.stage).toBe("discover");
    const research = buildHarnessRunner("research", {});
    expect(research.stage).toBe("research");
    const plan = buildHarnessRunner("plan", {});
    expect(plan.stage).toBe("plan");
  });

  test("design without designInput throws", () => {
    expect(() => buildHarnessRunner("design", {})).toThrow();
  });

  test("implement without implementInput throws", () => {
    expect(() => buildHarnessRunner("implement", {})).toThrow();
  });

  test("validate without validateInput throws", () => {
    expect(() => buildHarnessRunner("validate", {})).toThrow();
  });
});

describe("runHarnessPipelineUntilGate — auto-mode normalization", () => {
  let tmpDir: string;
  let cwd: string;
  let paths: ReturnType<typeof createTestPaths>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-pipeline-"));
    paths = createTestPaths(tmpDir);
    cwd = createTestRepo(tmpDir).repoRoot;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePlatform(): Platform {
    return { paths } as unknown as Platform;
  }

  function makeModelConfig(): ModelConfig {
    return { version: "1", default: null, actions: {} };
  }

  function freshSession(id: string): HarnessSession {
    const ts = new Date().toISOString();
    return {
      sessionId: id,
      projectName: "supipowers",
      startedAt: ts,
      updatedAt: ts,
      stage: "discover",
      stageStatus: "pending",
      gateMode: "default",
      iteration: 1,
      blocker: null,
      artifacts: {},
    };
  }

  function seedDiscover(sid: string) {
    saveHarnessDiscover(paths, cwd, sid, {
      sessionId: sid,
      recordedAt: new Date().toISOString(),
      languages: ["typescript"],
      frameworks: [],
      packageManagers: ["bun"],
      buildTools: ["tsc"],
      testTools: ["bun:test"],
      lintTools: [],
      monorepoShape: "single-package" as const,
      ci: { detected: false, configFiles: [] },
      ompInfra: {
        hasSupipowers: true,
        skills: [],
        reviewAgents: [],
        mcpServers: [],
        plansCount: 0,
      },
      antiSlopExisting: {
        fallowConfig: null,
        desloppifyConfig: null,
        knipConfig: null,
        jscpdConfig: null,
        dependencyCruiserConfig: null,
        eslintConfig: null,
        biomeConfig: null,
      },
      languageCoverage: [{ language: "typescript", fileCount: 10, share: 100 }],
      recommendedBackend: "fallow" as const,
      recommendedBackendReason: "primary language is typescript",
      commitConventions: { detected: false },
      duplicates: [],
      notes: [],
    });
  }

  // Regression: in auto mode, gated authoring stages that return
  // "awaiting-user" must be normalized to "completed" when they are not
  // actually waiting on external execution. Implement remains a real handoff.
  test("normalizes design awaiting-user to completed in auto-mode trace", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, freshSession(sid));
    seedDiscover(sid);

    const progressEvents: HarnessPipelineProgressEvent[] = [];
    const input: PipelineDriverInput = {
      platform: makePlatform(),
      paths,
      cwd,
      sessionId: sid,
      modelConfig: makeModelConfig(),
      gates: "auto",
      stageInputs: {},
      onProgress: (event) => progressEvents.push(event),
    };

    // The pipeline runs discover → research → design → plan → implement.
    // Design returns "awaiting-user". In auto mode this must be normalized.
    const outcome = await runHarnessPipelineUntilGate(input);

    // Trace: design must show "completed", not "awaiting-user".
    const designTrace = outcome.trace.find((t) => t.stage === "design");
    expect(designTrace).toBeDefined();
    expect(designTrace!.status).toBe("completed");

    // Outcome now stops at Implement because that awaiting-user means the
    // saved plan still has to be executed by the active agent.
    expect(outcome.stage).toBe("implement");
    expect(outcome.status).toBe("awaiting-user");

    // Progress events: design must not surface as awaiting-user in auto mode.
    const designAwaitingEvents = progressEvents.filter(
      (e) => e.type === "awaiting-user" && e.stage === "design",
    );
    expect(designAwaitingEvents).toHaveLength(0);

    // Design completion event must fire as "stage-completed".
    const designCompleted = progressEvents.filter(
      (e) => e.type === "stage-completed" && e.stage === "design",
    );
    expect(designCompleted.length).toBeGreaterThanOrEqual(1);
  });

  test("stops at implement handoff in auto mode instead of validating unapplied artifacts", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, freshSession(sid));
    const planMarkdown = [
      "---",
      `name: harness-${sid}`,
      "created: 2026-05-03T12:00:00.000Z",
      "---",
      "",
      "## Tasks",
      "",
      "### Task 1: Generate AGENTS.md",
      "**criteria**: AGENTS.md updated",
      "**complexity**: small",
    ].join("\n");
    savePlan(paths, cwd, `harness-${sid}.md`, planMarkdown);

    const progressEvents: HarnessPipelineProgressEvent[] = [];
    const outcome = await runHarnessPipelineUntilGate({
      platform: makePlatform(),
      paths,
      cwd,
      sessionId: sid,
      modelConfig: makeModelConfig(),
      gates: "auto",
      stageInputs: {},
      startStage: "implement",
      onProgress: (event) => progressEvents.push(event),
    });

    expect(outcome.stage).toBe("implement");
    expect(outcome.status).toBe("awaiting-user");
    expect(outcome.trace).toEqual([{ stage: "implement", status: "awaiting-user" }]);
    expect(outcome.trace.some((entry) => entry.stage === "validate")).toBe(false);
    expect(progressEvents).toContainEqual({
      type: "awaiting-user",
      stage: "implement",
      detail: "awaiting-user",
    });
  });

  // Default gates preserve "awaiting-user" as a gate signal.
  test("preserves awaiting-user in default gate mode", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, freshSession(sid));
    seedDiscover(sid);

    const input: PipelineDriverInput = {
      platform: makePlatform(),
      paths,
      cwd,
      sessionId: sid,
      modelConfig: makeModelConfig(),
      gates: "default",
      stageInputs: {},
      onProgress: () => {},
    };

    const outcome = await runHarnessPipelineUntilGate(input);

    // Default gates: discover artifact is pre-seeded so it's skipped.
    // Research is not a gate. Design is a gate and returns "awaiting-user"
    // which causes the pipeline to stop at design.
    expect(outcome.stage).toBe("design");
    expect(outcome.status).toBe("awaiting-user");
  });
});
