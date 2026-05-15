/**
 * Regression: on the harden path, when the user records a new `ci.git` block, the
 * pipeline driver must be invoked with `forceStages` containing `implement` and
 * `validate`. Without that, both stages short-circuit on their `isComplete` checks
 * (the artifacts exist from the prior install) and the workflow file never re-renders
 * to include the `verify-pr-source` job — a silent no-op the user can't detect.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  handleHarness,
  setHarnessPipelineDriver,
  type HarnessCommandContext,
} from "../../src/harness/command.js";
import {
  saveHarnessDesignSpecJson,
  saveHarnessSession,
  appendImplementLog,
  saveHarnessValidateReport,
} from "../../src/harness/storage.js";
import { writeMarker } from "../../src/harness/bare-entry.js";
import { newHarnessSessionId } from "../../src/harness/stage-runner.js";
import { createTestPaths, createTestRepo } from "../ultraplan/fixtures.js";
import type { runHarnessPipelineUntilGate } from "../../src/harness/pipeline.js";
import type { Platform } from "../../src/platform/types.js";
import type { HarnessDesignSpec, HarnessSession } from "../../src/types.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-harden-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setHarnessPipelineDriver(null);
});

/**
 * Minimal `platform.exec` mock that satisfies every git/gh probe the harden path
 * hits before reaching the pipeline driver. Returns:
 *  - clean working tree for `git status --porcelain`,
 *  - `main` as the default branch + no other branches (so the QA flow takes the
 *    "create a new dev branch" path),
 *  - `gh auth status` fails so the ruleset step is skipped (we don't want to
 *    exercise the GitHub API surface here).
 */
function makeMockExec(): Platform["exec"] {
  return (async (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "status") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (cmd === "git" && args[0] === "symbolic-ref") {
      return { stdout: "refs/remotes/origin/main\n", stderr: "", code: 0 };
    }
    if (cmd === "git" && args[0] === "branch") {
      return { stdout: "main\n", stderr: "", code: 0 };
    }
    if (cmd === "git" && args[0] === "ls-remote") {
      return { stdout: "deadbeef\trefs/heads/main\n", stderr: "", code: 0 };
    }
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: "", stderr: "", code: 1 }; // branch doesn't exist locally
    }
    if (cmd === "git" && (args[0] === "switch" || args[0] === "push")) {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (cmd === "gh") {
      // Pretend gh is not authenticated so the ruleset path is skipped silently.
      return { stdout: "", stderr: "not logged in", code: 1 };
    }
    return { stdout: "", stderr: `unscripted: ${cmd} ${args.join(" ")}`, code: 127 };
  }) as Platform["exec"];
}

function makePlatform(): Platform {
  return { paths, exec: makeMockExec() } as unknown as Platform;
}

function freshSession(sessionId: string): HarnessSession {
  return {
    sessionId,
    projectName: "supipowers",
    startedAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    stage: "validate",
    stageStatus: "done",
    gateMode: "default",
    iteration: 1,
    blocker: null,
    artifacts: {},
  };
}

function specWithoutGitBlock(sessionId: string): HarnessDesignSpec {
  return {
    sessionId,
    recordedAt: "2026-05-14T00:00:00.000Z",
    layerRules: [],
    tasteInvariants: [],
    tooling: { lint: null, structuralTest: null, eval: null },
    goldenPrinciples: [],
    docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
    validationGates: [],
    supipowersWiring: { addReviewAgent: true, wireChecksGate: false },
    ci: {
      provider: "github-actions",
      trigger: { mode: "branches", branches: ["main"] },
      localCommand: "bun run harness:quality",
      workflowPath: ".github/workflows/harness-quality.yml",
    },
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

/**
 * Build a ctx whose `select`/`input` answers the prompts in the order they fire on
 * the harden path:
 *  1. resolveBareEntry  → "Harden — gap-fill, preserve hand-tuned configs"
 *  2. runGitVerificationQa top-level → "Run verification"
 *  3. "Do you have a development branch?" → "No, I don't have one"
 *  4. "Do you want a dedicated development branch?" → "Yes — create one"
 *  5. (input) "What name? (default: dev)" → "dev"
 *  6. "Create new branch from main, or promote..." → "Create new branch from main"
 *
 * The labels here MUST match the strings in `runGitVerificationQa` and
 * `resolveBareEntry`; if they drift, the test will fail loudly.
 */
function makeCtx(): HarnessCommandContext & { notifications: { message: string }[] } {
  const notifications: { message: string }[] = [];
  const selectAnswers = [
    "Harden — gap-fill, preserve hand-tuned configs",
    "Run verification",
    "No, I don't have one",
    "Yes — create one",
    "Create new branch from main",
  ];
  const inputAnswers = ["dev"];
  return {
    cwd,
    ui: {
      notify: (message: string) => { notifications.push({ message }); },
      select: async (_title: string, _options: unknown[]) =>
        selectAnswers.shift() ?? null,
      input: async (_label: string) => inputAnswers.shift() ?? null,
    },
    notifications,
  };
}

describe("handleHarness — harden path with git verification", () => {
  test("forces implement + validate to re-run after capturing a new ci.git block", async () => {
    // ── Seed: harness is already installed. Marker present, design spec persisted,
    //         implement-log records a successful prior apply, validate-report.json
    //         exists. Without the harden-path force, both stages would short-circuit
    //         on isComplete and the workflow would never re-render.
    const sid = newHarnessSessionId();
    writeMarker(paths, cwd, { installedAt: "2026-05-13T00:00:00.000Z", backend: "fallow" });
    saveHarnessSession(paths, cwd, freshSession(sid));
    saveHarnessDesignSpecJson(paths, cwd, sid, specWithoutGitBlock(sid));
    appendImplementLog(paths, cwd, sid, {
      kind: "applied",
      at: "2026-05-13T00:00:00.000Z",
      applied: [],
      warnings: [],
      errors: [],
    } as unknown as Record<string, unknown>);
    saveHarnessValidateReport(paths, cwd, sid, {
      passed: true,
      score: { strict: 100, lenient: 100 },
      checks: [],
      generatedAt: "2026-05-13T00:00:00.000Z",
    } as never);

    // ── Mock the pipeline driver so we can assert how it is invoked. We don't care
    //    about real pipeline behavior here — only that the harden code path
    //    propagates `forceStages` correctly.
    const driver = mock(async () => ({
      stage: "validate" as const,
      status: "completed" as const,
      promoted: true,
      trace: [],
    }));
    setHarnessPipelineDriver(driver as never);

    await handleHarness(makePlatform(), makeCtx());

    expect(driver).toHaveBeenCalledTimes(1);
    const call = (driver.mock.calls[0] as unknown as [
      Parameters<typeof runHarnessPipelineUntilGate>[0],
    ])[0];
    // The contract: the harden path passes `forceStages` containing both implement
    // and validate so a stale `implement-log.jsonl` / `validate-report.json` does
    // not cause the new workflow to be silently skipped.
    expect(call.forceStages).toBeDefined();
    expect(call.forceStages!.has("implement")).toBe(true);
    expect(call.forceStages!.has("validate")).toBe(true);
    expect(call.gates).toBe("auto");
  });

  test("does NOT pass forceStages when the user declines the git verification flow", async () => {
    // Same seed, but the user picks "Skip" at the top-level verification prompt.
    // runGitVerificationOnHarden returns false and the harden path runs the pipeline
    // as before (every stage short-circuits — and that's correct, because nothing
    // changed).
    const sid = newHarnessSessionId();
    writeMarker(paths, cwd, { installedAt: "2026-05-13T00:00:00.000Z", backend: "fallow" });
    saveHarnessSession(paths, cwd, freshSession(sid));
    saveHarnessDesignSpecJson(paths, cwd, sid, specWithoutGitBlock(sid));

    const driver = mock(async () => ({
      stage: "validate" as const,
      status: "completed" as const,
      promoted: true,
      trace: [],
    }));
    setHarnessPipelineDriver(driver as never);

    // Override ui to answer "Skip" at the verification prompt after "harden".
    const ctx: HarnessCommandContext = {
      cwd,
      ui: {
        notify: () => {},
        select: (() => {
          const answers = [
            "Harden — gap-fill, preserve hand-tuned configs",
            "Skip",
          ];
          return async () => answers.shift() ?? null;
        })(),
        input: async () => null,
      },
    };

    await handleHarness(makePlatform(), ctx);

    expect(driver).toHaveBeenCalledTimes(1);
    const call = (driver.mock.calls[0] as unknown as [
      Parameters<typeof runHarnessPipelineUntilGate>[0],
    ])[0];
    expect(call.forceStages).toBeUndefined();
  });
});
