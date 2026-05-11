import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { handlePrComment } from "../../../src/harness/pr-comment/handler.js";
import { saveHarnessValidateReport, saveHarnessDesignSpecJson } from "../../../src/harness/storage.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type {
  HarnessDesignSpec,
  HarnessValidateReport,
} from "../../../src/types.js";
import type { Platform } from "../../../src/platform/types.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-pr-handler-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx() {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    cwd,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
    },
    notifications,
  };
}

function makePlatform(execImpl?: Platform["exec"]): Platform {
  const exec = execImpl ?? mock(async () => ({ stdout: "", stderr: "", code: 0 }));
  return { paths, exec } as unknown as Platform;
}

function passingReport(sessionId: string): HarnessValidateReport {
  return {
    sessionId,
    recordedAt: "2026-05-11T12:00:00.000Z",
    passed: true,
    checks: [
      {
        name: "cross-link-check", passed: true, summary: "", findings: [],
        invariant: "x", proves: "y", doesNotProve: "z", artifact: "a", failSafe: "f",
      },
    ],
    slopScan: { backend: "fallow", duplicates: 0, deadCode: 0, layerViolations: 0, other: 0 },
    score: {
      computedAt: "2026-05-11T12:00:00.000Z",
      lenient: 100, strict: 100,
      dimensions: [
        { name: "duplicates", lenient: 100, strict: 100, total: 0, open: 0, resolved: 0, wontfix: 0 },
        { name: "deadCode", lenient: 100, strict: 100, total: 0, open: 0, resolved: 0, wontfix: 0 },
        { name: "layerViolations", lenient: 100, strict: 100, total: 0, open: 0, resolved: 0, wontfix: 0 },
        { name: "other", lenient: 100, strict: 100, total: 0, open: 0, resolved: 0, wontfix: 0 },
      ],
    },
    scoreFloorPassed: true,
    syntheticEditTest: { ran: true, hooksFired: [], failures: [] },
  };
}

function designSpec(sessionId: string): HarnessDesignSpec {
  return {
    sessionId,
    recordedAt: "2026-05-11T12:00:00.000Z",
    layerRules: [],
    tasteInvariants: [],
    tooling: { lint: null, structuralTest: null, eval: null },
    goldenPrinciples: [],
    docsTree: [],
    validationGates: [],
    ci: {
      provider: "github-actions",
      trigger: { mode: "all-prs" },
      localCommand: "bun run harness:quality",
      workflowPath: ".github/workflows/harness.yml",
      prComment: { enabled: true, mode: "every-push" },
    },
    supipowersWiring: { addReviewAgent: false, wireChecksGate: false },
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

describe("handlePrComment", () => {
  test("notifies error when no harness session exists", async () => {
    const ctx = makeCtx();
    const exec = mock(async () => ({ stdout: "", stderr: "", code: 0 }));
    await handlePrComment(makePlatform(exec), ctx, []);
    expect(ctx.notifications[0]?.type).toBe("error");
    expect(ctx.notifications[0]?.message).toContain("No harness session");
    expect(exec).not.toHaveBeenCalled();
  });

  test("--dry-run prints the body and does NOT call exec", async () => {
    const sessionId = "sess-1";
    saveHarnessValidateReport(paths, cwd, sessionId, passingReport(sessionId));
    saveHarnessDesignSpecJson(paths, cwd, sessionId, designSpec(sessionId));

    const ctx = makeCtx();
    const exec = mock(async () => ({ stdout: "", stderr: "", code: 0 }));
    await handlePrComment(makePlatform(exec), ctx, ["--dry-run", "--session=sess-1"]);

    expect(ctx.notifications[0]?.message).toContain("PR comment preview");
    expect(ctx.notifications[0]?.message).toContain("status=passed");
    expect(ctx.notifications[0]?.message).toContain("🟢 Harness");
    expect(exec).not.toHaveBeenCalled();
  });

  test("no PR context (no env, no flags) skips with a notification and no exec call", async () => {
    const sessionId = "sess-2";
    saveHarnessValidateReport(paths, cwd, sessionId, passingReport(sessionId));
    saveHarnessDesignSpecJson(paths, cwd, sessionId, designSpec(sessionId));

    const ctx = makeCtx();
    const exec = mock(async () => ({ stdout: "", stderr: "", code: 0 }));

    // Ensure detectCiContext returns null by clearing the relevant env vars for this test.
    const originalRepo = process.env.GITHUB_REPOSITORY;
    const originalEvent = process.env.GITHUB_EVENT_PATH;
    const originalSummary = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_EVENT_PATH;
    delete process.env.GITHUB_STEP_SUMMARY;

    try {
      await handlePrComment(makePlatform(exec), ctx, ["--session=sess-2"]);
    } finally {
      if (originalRepo !== undefined) process.env.GITHUB_REPOSITORY = originalRepo;
      if (originalEvent !== undefined) process.env.GITHUB_EVENT_PATH = originalEvent;
      if (originalSummary !== undefined) process.env.GITHUB_STEP_SUMMARY = originalSummary;
    }

    expect(exec).not.toHaveBeenCalled();
    expect(ctx.notifications[0]?.message.toLowerCase()).toMatch(/no pr context|skipped/);
  });

  test("flag-override CI context calls gh and reports success on create", async () => {
    const sessionId = "sess-3";
    saveHarnessValidateReport(paths, cwd, sessionId, passingReport(sessionId));
    saveHarnessDesignSpecJson(paths, cwd, sessionId, designSpec(sessionId));

    const ctx = makeCtx();
    const responses = [
      { stdout: "", stderr: "", code: 0 }, // gh auth status
      { stdout: "", stderr: "", code: 0 }, // list comments (empty)
      { stdout: '{"id":7777}', stderr: "", code: 0 }, // POST
    ];
    const exec = mock(async (_bin: string, _args: string[]) => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected exec call");
      return next;
    });

    await handlePrComment(makePlatform(exec as unknown as Platform["exec"]), ctx, [
      "--session=sess-3",
      "--pr=42",
      "--repo=octo/cat",
    ]);

    expect(exec).toHaveBeenCalled();
    expect(ctx.notifications[0]?.type).toBe("info");
    expect(ctx.notifications[0]?.message).toContain("created");
  });

  test("config disabled (prComment.enabled=false) skips posting outside --dry-run", async () => {
    const sessionId = "sess-4";
    saveHarnessValidateReport(paths, cwd, sessionId, passingReport(sessionId));
    const disabledSpec = designSpec(sessionId);
    disabledSpec.ci.prComment = { enabled: false, mode: "every-push" };
    saveHarnessDesignSpecJson(paths, cwd, sessionId, disabledSpec);

    const ctx = makeCtx();
    const exec = mock(async () => ({ stdout: "", stderr: "", code: 0 }));
    await handlePrComment(makePlatform(exec), ctx, ["--session=sess-4"]);
    expect(exec).not.toHaveBeenCalled();
    expect(ctx.notifications[0]?.message).toContain("disabled");
  });

  test("config disabled is overridden by --dry-run (renders for preview)", async () => {
    const sessionId = "sess-5";
    saveHarnessValidateReport(paths, cwd, sessionId, passingReport(sessionId));
    const disabledSpec = designSpec(sessionId);
    disabledSpec.ci.prComment = { enabled: false, mode: "every-push" };
    saveHarnessDesignSpecJson(paths, cwd, sessionId, disabledSpec);

    const ctx = makeCtx();
    const exec = mock(async () => ({ stdout: "", stderr: "", code: 0 }));
    await handlePrComment(makePlatform(exec), ctx, ["--dry-run", "--session=sess-5"]);
    expect(exec).not.toHaveBeenCalled();
    expect(ctx.notifications[0]?.message).toContain("preview");
  });
});
