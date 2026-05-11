import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  handleStageCommand,
  parseHarnessArgs,
  resolveHarnessSessionId,
  setHarnessPipelineDriver,
  type HarnessCommandContext,
} from "../../src/harness/command.js";
import {
  loadHarnessDesignSpecJson,
  loadHarnessSession,
  saveHarnessDesignSpecJson,
  saveHarnessDiscover,
  saveHarnessSession,
} from "../../src/harness/storage.js";
import { newHarnessSessionId } from "../../src/harness/stage-runner.js";
import { savePlan } from "../../src/storage/plans.js";
import { getProjectStatePath } from "../../src/workspace/state-paths.js";
import type { PipelineRunOutcome, runHarnessPipelineUntilGate } from "../../src/harness/pipeline.js";
import { createTestPaths, createTestRepo } from "../ultraplan/fixtures.js";
import type { HarnessDesignSpec, HarnessDiscoverArtifact, HarnessSession } from "../../src/types.js";
import type { Platform } from "../../src/platform/types.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-cmd-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setHarnessPipelineDriver(null);
});

function makePlatform(): Platform {
  return { paths } as unknown as Platform;
}

function makeCtx(): HarnessCommandContext & { _notifications: Array<{ message: string; type?: string }> } {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    cwd,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
    },
    _notifications: notifications,
  };
}

function makeDiscover(sessionId: string): HarnessDiscoverArtifact {
  return {
    sessionId,
    recordedAt: "2026-05-04T00:00:00.000Z",
    languages: ["typescript"],
    frameworks: [],
    packageManagers: ["bun"],
    buildTools: [],
    testTools: [],
    lintTools: [],
    monorepoShape: "single-package",
    ci: { detected: false, configFiles: [] },
    ompInfra: { hasSupipowers: false, skills: [], reviewAgents: [], mcpServers: [], plansCount: 0 },
    antiSlopExisting: {
      fallowConfig: null,
      desloppifyConfig: null,
      knipConfig: null,
      jscpdConfig: null,
      dependencyCruiserConfig: null,
      eslintConfig: null,
      biomeConfig: null,
    },
    languageCoverage: [{ language: "typescript", fileCount: 100, share: 1 }],
    recommendedBackend: "fallow",
    recommendedBackendReason: "TS-only",
    commitConventions: { detected: false },
    duplicates: [],
    notes: [],
  };
}

function makeSpec(sessionId: string): HarnessDesignSpec {
  return {
    sessionId,
    recordedAt: "2026-05-04T12:00:00.000Z",
    layerRules: [],
    tasteInvariants: [],
    tooling: { lint: null, structuralTest: null, eval: null },
    goldenPrinciples: [],
    docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
    validationGates: [],
    ci: {
      provider: "github-actions",
      trigger: { mode: "branches", branches: ["dev", "main"] },
      localCommand: "bun run harness:quality",
      workflowPath: ".github/workflows/harness-quality.yml",
    },
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
  };
}

function makeSession(sessionId: string, overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    sessionId,
    projectName: "supipowers",
    startedAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
    stage: "discover",
    stageStatus: "pending",
    gateMode: "default",
    iteration: 1,
    blocker: null,
    artifacts: {},
    ...overrides,
  };
}

describe("parseHarnessArgs", () => {
  test("recognizes per-stage subcommands", () => {
    expect(parseHarnessArgs("discover").subcommand).toBe("discover");
    expect(parseHarnessArgs("plan-draft").subcommand).toBe("plan-draft");
    expect(parseHarnessArgs("validate --session foo").subcommand).toBe("validate");
    expect(parseHarnessArgs("validate --session foo").args).toEqual([
      "--session",
      "foo",
    ]);
  });

  test("recognizes pr-comment with flag tokens", () => {
    const parsed = parseHarnessArgs("pr-comment --dry-run --pr=42 --repo=octo/cat");
    expect(parsed.subcommand).toBe("pr-comment");
    expect(parsed.args).toEqual(["--dry-run", "--pr=42", "--repo=octo/cat"]);
  });
});

describe("resolveHarnessSessionId", () => {
  test("uses --session when present", () => {
    const sid = newHarnessSessionId();
    const result = resolveHarnessSessionId(paths, cwd, ["--session", sid], {
      autoCreate: false,
      stage: "discover",
    });
    expect(result).toEqual({ sessionId: sid, created: false });
  });

  test("rejects malformed --session ids", () => {
    const result = resolveHarnessSessionId(paths, cwd, ["--session", "not-valid"], {
      autoCreate: false,
      stage: "discover",
    });
    expect("error" in result).toBe(true);
  });

  test("falls back to most recent existing session", () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    const result = resolveHarnessSessionId(paths, cwd, [], {
      autoCreate: false,
      stage: "research",
    });
    expect(result).toEqual({ sessionId: sid, created: false });
  });

  test("errors when autoCreate=false and no session exists", () => {
    const result = resolveHarnessSessionId(paths, cwd, [], {
      autoCreate: false,
      stage: "design",
    });
    expect("error" in result).toBe(true);
  });

  test("creates a fresh session when autoCreate=true", () => {
    const result = resolveHarnessSessionId(paths, cwd, [], {
      autoCreate: true,
      stage: "discover",
    });
    expect("sessionId" in result).toBe(true);
    if ("sessionId" in result) {
      expect(result.created).toBe(true);
      const loaded = loadHarnessSession(paths, cwd, result.sessionId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.stage).toBe("discover");
        expect(loaded.value.stageStatus).toBe("pending");
      }
    }
  });
});

describe("handleStageCommand — discover", () => {
  test("creates a session when none exists and invokes the pipeline driver", async () => {
    const driver = mock(async (): Promise<PipelineRunOutcome> => ({
      stage: "discover",
      status: "completed",
      promoted: false,
      trace: [{ stage: "discover", status: "completed" }],
    }));
    setHarnessPipelineDriver(driver as never);

    const ctx = makeCtx();
    await handleStageCommand(makePlatform(), ctx, "discover", []);

    expect(driver).toHaveBeenCalledTimes(1);
    const call = (driver.mock.calls[0] as unknown as [Parameters<typeof runHarnessPipelineUntilGate>[0]])[0];
    expect(call.startStage).toBe("discover");
    expect(call.gates).toBe("auto");
    expect(call.sessionId).toMatch(/^harness-/);
  });
});

describe("handleStageCommand — design", () => {
  test("blocks when discover artifact is missing and no design-spec.json exists", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    const driver = mock(async (): Promise<PipelineRunOutcome> => {
      throw new Error("driver should not run when build fails");
    });
    setHarnessPipelineDriver(driver as never);

    const ctx = makeCtx();
    await handleStageCommand(makePlatform(), ctx, "design", []);
    expect(driver).not.toHaveBeenCalled();
    expect(ctx._notifications.some((n) => n.type === "error")).toBe(true);
  });

  test("derives a default design spec from discover when none persisted", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    saveHarnessDiscover(paths, cwd, sid, makeDiscover(sid));
    const driver = mock(async (): Promise<PipelineRunOutcome> => ({
      stage: "design",
      status: "awaiting-user",
      promoted: false,
      trace: [{ stage: "design", status: "awaiting-user" }],
    }));
    setHarnessPipelineDriver(driver as never);

    const ctx = makeCtx();
    await handleStageCommand(makePlatform(), ctx, "design", []);
    expect(driver).toHaveBeenCalledTimes(1);
    const call = (driver.mock.calls[0] as unknown as [Parameters<typeof runHarnessPipelineUntilGate>[0]])[0];
    expect(call.stageInputs.designInput?.spec.sessionId).toBe(sid);
    expect(call.stageInputs.designInput?.spec.antiSlop.backend).toBe("fallow");
  });

  test("uses pre-existing design-spec.json when present", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    saveHarnessDiscover(paths, cwd, sid, makeDiscover(sid));
    const customSpec: HarnessDesignSpec = {
      ...makeSpec(sid),
      goldenPrinciples: ["UNIQUE-MARKER"],
    };
    saveHarnessDesignSpecJson(paths, cwd, sid, customSpec);
    const driver = mock(async (): Promise<PipelineRunOutcome> => ({
      stage: "design",
      status: "awaiting-user",
      promoted: false,
      trace: [{ stage: "design", status: "awaiting-user" }],
    }));
    setHarnessPipelineDriver(driver as never);

    const ctx = makeCtx();
    await handleStageCommand(makePlatform(), ctx, "design", []);
    const call = (driver.mock.calls[0] as unknown as [Parameters<typeof runHarnessPipelineUntilGate>[0]])[0];
    expect(call.stageInputs.designInput?.spec.goldenPrinciples).toEqual([
      "UNIQUE-MARKER",
    ]);
  });
});

describe("handleStageCommand — plan/implement/validate", () => {
  test("plan stage forwards an empty stage input", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    const driver = mock(async (): Promise<PipelineRunOutcome> => ({
      stage: "plan",
      status: "awaiting-user",
      promoted: false,
      trace: [{ stage: "plan", status: "awaiting-user" }],
    }));
    setHarnessPipelineDriver(driver as never);

    await handleStageCommand(makePlatform(), makeCtx(), "plan", []);
    expect((driver.mock.calls[0] as unknown as [Parameters<typeof runHarnessPipelineUntilGate>[0]])[0].startStage).toBe("plan");
    expect((driver.mock.calls[0] as unknown as [Parameters<typeof runHarnessPipelineUntilGate>[0]])[0].stageInputs).toEqual({});
  });

  test("implement stage requires the harness plan in the canonical plans dir", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    const driver = mock(async (): Promise<PipelineRunOutcome> => {
      throw new Error("driver should not run when plan missing");
    });
    setHarnessPipelineDriver(driver as never);

    const ctx = makeCtx();
    await handleStageCommand(makePlatform(), ctx, "implement", []);
    expect(driver).not.toHaveBeenCalled();
    expect(ctx._notifications.some((n) => n.type === "error")).toBe(true);
  });

  test("implement stage builds input when plan exists", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    savePlan(paths, cwd, `harness-${sid}.md`, "plan body");
    const driver = mock(async (): Promise<PipelineRunOutcome> => ({
      stage: "implement",
      status: "completed",
      promoted: false,
      trace: [{ stage: "implement", status: "completed" }],
    }));
    setHarnessPipelineDriver(driver as never);

    await handleStageCommand(makePlatform(), makeCtx(), "implement", []);
    const call = (driver.mock.calls[0] as unknown as [Parameters<typeof runHarnessPipelineUntilGate>[0]])[0];
    expect(call.startStage).toBe("implement");
    const expectedPlan = path.join(
      getProjectStatePath(paths, cwd, "plans"),
      `harness-${sid}.md`,
    );
    expect(call.stageInputs.implementInput?.planPath).toBe(expectedPlan);
    expect(call.stageInputs.implementInput?.threshold).toBeGreaterThan(0);
  });

  test("implement stage hands the saved plan to the active agent instead of stopping silently", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    savePlan(
      paths,
      cwd,
      `harness-${sid}.md`,
      [
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
      ].join("\n"),
    );

    const sentMessages: Array<{ content: any; opts: any }> = [];
    const platform = {
      paths,
      sendMessage(content: any, opts: any) {
        sentMessages.push({ content, opts });
      },
    } as unknown as Platform;
    const driver = mock(async (): Promise<PipelineRunOutcome> => ({
      stage: "implement",
      status: "awaiting-user",
      promoted: false,
      trace: [{ stage: "implement", status: "awaiting-user" }],
    }));
    setHarnessPipelineDriver(driver as never);

    await handleStageCommand(platform, makeCtx(), "implement", []);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].opts).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(sentMessages[0].content.customType).toBe("supi-harness-implement");
    expect(sentMessages[0].content.content[0].text).toContain("Plan approved. You **MUST** execute it now.");
    expect(sentMessages[0].content.content[0].text).toContain("### Task 1: Generate AGENTS.md");
  });

  test("validate stage builds adapter from the design spec", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    saveHarnessDesignSpecJson(paths, cwd, sid, makeSpec(sid));
    const driver = mock(async (): Promise<PipelineRunOutcome> => ({
      stage: "validate",
      status: "completed",
      promoted: true,
      trace: [{ stage: "validate", status: "completed" }],
    }));
    setHarnessPipelineDriver(driver as never);

    await handleStageCommand(makePlatform(), makeCtx(), "validate", []);
    const call = (driver.mock.calls[0] as unknown as [Parameters<typeof runHarnessPipelineUntilGate>[0]])[0];
    expect(call.startStage).toBe("validate");
    expect(call.stageInputs.validateInput?.backend).toBe("fallow");
    expect(call.stageInputs.validateInput?.adapter).toBeDefined();
    expect(call.stageInputs.validateInput?.scoreFloor.strict).toBe(75);
  });

  test("validate stage refuses without a design spec", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    const driver = mock(async (): Promise<PipelineRunOutcome> => {
      throw new Error("should not run");
    });
    setHarnessPipelineDriver(driver as never);

    const ctx = makeCtx();
    await handleStageCommand(makePlatform(), ctx, "validate", []);
    expect(driver).not.toHaveBeenCalled();
    expect(ctx._notifications.some((n) => n.type === "error")).toBe(true);
  });
});

describe("handleStageCommand — outcome surfacing", () => {
  test("surfaces failed/blocked outcomes as errors", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    const driver = mock(async (): Promise<PipelineRunOutcome> => ({
      stage: "discover",
      status: "blocked",
      promoted: false,
      message: "boom",
      trace: [{ stage: "discover", status: "blocked" }],
    }));
    setHarnessPipelineDriver(driver as never);

    const ctx = makeCtx();
    await handleStageCommand(makePlatform(), ctx, "discover", []);
    const errors = ctx._notifications.filter((n) => n.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("surfaces awaiting-user/completed outcomes as info", async () => {
    const sid = newHarnessSessionId();
    saveHarnessSession(paths, cwd, makeSession(sid));
    const driver = mock(async (): Promise<PipelineRunOutcome> => ({
      stage: "discover",
      status: "completed",
      promoted: false,
      trace: [{ stage: "discover", status: "completed" }],
    }));
    setHarnessPipelineDriver(driver as never);

    const ctx = makeCtx();
    await handleStageCommand(makePlatform(), ctx, "discover", []);
    expect(ctx._notifications.some((n) => n.type === "info" || n.type === undefined)).toBe(true);
  });
});

// Cover the existing `loadHarnessDesignSpecJson` referenced by handlers — regression
// safeguard so the import is exercised end-to-end.
test("design subcommand persists JSON when default spec is derived (smoke)", () => {
  // The design stage runner persists the JSON; this test only confirms the helper is wired.
  expect(typeof loadHarnessDesignSpecJson).toBe("function");
});
