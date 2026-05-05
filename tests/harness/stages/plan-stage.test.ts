import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HarnessPlanStage } from "../../../src/harness/stages/plan.js";
import { saveHarnessDesignSpecJson } from "../../../src/harness/storage.js";
import { getProjectStatePath } from "../../../src/workspace/state-paths.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { HarnessDesignSpec } from "../../../src/types.js";
import type { HarnessStageRunnerContext } from "../../../src/harness/stage-runner.js";

const SESSION_ID = "harness-plan-stage-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-plan-stage-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSpec(overrides: Partial<HarnessDesignSpec> = {}): HarnessDesignSpec {
  return {
    sessionId: SESSION_ID,
    recordedAt: "2026-05-04T12:00:00.000Z",
    layerRules: [],
    tasteInvariants: [],
    tooling: { lint: "eslint", structuralTest: null, eval: null },
    goldenPrinciples: [],
    docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
    validationGates: ["typecheck", "test"],
    supipowersWiring: { addReviewAgent: true, wireChecksGate: false },
    antiSlop: {
      backend: "fallow",
      hooks: {
        pre_edit_dupe_probe: { enabled: true, threshold: 0.85, min_token_count: 30 },
        post_session_sweep: { enabled: true, block_on_new_dead_code: false },
        layer_context_inject: { enabled: true, addendum_max_chars: 800 },
        score_floor: { strict: 75, lenient: 90, release_blocking: false },
      },
      skillTargets: [],
    },
    ...overrides,
  };
}

function ctx(): HarnessStageRunnerContext {
  return {
    platform: { paths } as unknown as HarnessStageRunnerContext["platform"],
    paths,
    cwd,
    sessionId: SESSION_ID,
    modelConfig: { version: "1", default: null, actions: {} },
    gateMode: "default",
    now: () => "2026-05-04T12:00:00.000Z",
  };
}

describe("HarnessPlanStage", () => {
  test("blocks when no design-spec.json is present", async () => {
    const stage = new HarnessPlanStage();
    const result = await stage.run(ctx());
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.blocker?.code).toBe("design-spec-missing");
    }
  });

  test("isReady returns false when design-spec.json is absent", async () => {
    const stage = new HarnessPlanStage();
    expect(await stage.isReady(ctx())).toBe(false);
  });

  test("emits a plan markdown into the canonical plans dir when design-spec.json exists", async () => {
    saveHarnessDesignSpecJson(paths, cwd, SESSION_ID, makeSpec());
    const stage = new HarnessPlanStage();
    const result = await stage.run(ctx());
    expect(result.status).toBe("awaiting-user");
    const plansDir = getProjectStatePath(paths, cwd, "plans");
    const expectedPlan = path.join(plansDir, `harness-${SESSION_ID}.md`);
    expect(fs.existsSync(expectedPlan)).toBe(true);
    expect(result.artifactPaths).toEqual([expectedPlan]);
    expect(result.details?.taskCount).toBeGreaterThan(0);
  });

  test("isComplete returns true after a successful run", async () => {
    saveHarnessDesignSpecJson(paths, cwd, SESSION_ID, makeSpec());
    const stage = new HarnessPlanStage();
    expect(await stage.isComplete(ctx())).toBe(false);
    const result = await stage.run(ctx());
    expect(result.status).toBe("awaiting-user");
    expect(await stage.isComplete(ctx())).toBe(true);
  });

  test("respects custom planFilename override", async () => {
    saveHarnessDesignSpecJson(paths, cwd, SESSION_ID, makeSpec());
    const stage = new HarnessPlanStage({ planFilename: "harness-custom" });
    const result = await stage.run(ctx());
    expect(result.status).toBe("awaiting-user");
    const plansDir = getProjectStatePath(paths, cwd, "plans");
    const customPath = path.join(plansDir, "harness-custom.md");
    expect(fs.existsSync(customPath)).toBe(true);
  });
});
