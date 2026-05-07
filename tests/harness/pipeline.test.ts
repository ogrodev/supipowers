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

  // Regression: in auto mode, stages that return "awaiting-user" must be
  // normalized to "completed" in both the trace and the final outcome.
  // Without this, the progress UI shows checkmarks while the system reports
  // "awaiting user", which is confusing during rebuild.
  test("normalizes awaiting-user to completed in trace and validate outcome", async () => {
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

    // The pipeline runs discover → research → design → plan → implement → validate.
    // Design returns "awaiting-user". In auto mode this must be normalized.
    const outcome = await runHarnessPipelineUntilGate(input);

    // Trace: design must show "completed", not "awaiting-user".
    const designTrace = outcome.trace.find((t) => t.stage === "design");
    expect(designTrace).toBeDefined();
    expect(designTrace!.status).toBe("completed");

    // Outcome: must not report "awaiting-user" from any stage.
    // (Validate may fail in a bare test repo — that's orthogonal to the normalization.)
    expect(outcome.status).not.toBe("awaiting-user");

    // Pipeline must have run at least through design (normalization target).
    const validateTrace = outcome.trace.find((t) => t.stage === "validate");
    expect(validateTrace).toBeDefined();

    // Progress events: no "awaiting-user" events in auto mode.
    const awaitingEvents = progressEvents.filter((e) => e.type === "awaiting-user");
    expect(awaitingEvents).toHaveLength(0);

    // Design completion event must fire as "stage-completed".
    const designCompleted = progressEvents.filter(
      (e) => e.type === "stage-completed" && e.stage === "design",
    );
    expect(designCompleted.length).toBeGreaterThanOrEqual(1);
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
