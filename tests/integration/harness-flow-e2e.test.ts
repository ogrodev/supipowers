/**
 * End-to-end integration test for the per-stage `/supi:harness` subcommands.
 *
 * Drives the actual pipeline driver (no mocks) through discover → research → design →
 * plan-draft → implement → validate on a fresh tmp repo and asserts the artifacts each
 * stage commits to disk. This exercises the wiring added in the harness follow-on (#2):
 *
 *  - per-stage subcommands reach the real `runHarnessPipelineUntilGate`,
 *  - sessions are auto-created on the first `discover` and reused thereafter,
 *  - `design` auto-derives a default spec from `discover.json` and persists JSON,
 *  - `plan-draft` rehydrates from `design-spec.json` and emits the plan markdown.
 *
 * Implement and validate are exercised but their full passage requires a real harness
 * install (AGENTS.md, fallow CLI, etc.) — out of scope here. We assert that the
 * subcommands run through the pipeline and surface a structured outcome.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  handleHarness,
  handleStageCommand,
  type HarnessCommandContext,
} from "../../src/harness/command.js";
import {
  loadHarnessDesignSpecJson,
  loadHarnessDiscover,
  listHarnessSessions,
} from "../../src/harness/storage.js";
import {
  getHarnessDesignSpecPath,
  getHarnessResearchDir,
  getHarnessSessionDir,
  getHarnessValidateReportPath,
} from "../../src/harness/project-paths.js";
import { getProjectStatePath } from "../../src/workspace/state-paths.js";
import { createTestPaths, createTestRepo } from "../ultraplan/fixtures.js";
import type { Platform } from "../../src/platform/types.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-flow-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePlatform(): Platform {
  return {
    paths,
    sendMessage() {},
    sendUserMessage() {},
  } as unknown as Platform;
}

interface CapturedNotification {
  message: string;
  type?: "info" | "warning" | "error";
}

function makeCtx(): HarnessCommandContext & { notifications: CapturedNotification[] } {
  const notifications: CapturedNotification[] = [];
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

describe("/supi:harness per-stage flow", () => {
  test("discover → research → design → plan-draft chain produces the expected artifacts", async () => {
    const platform = makePlatform();
    const ctx = makeCtx();

    // Step 1: discover. Auto-creates a session and emits discover.json.
    await handleStageCommand(platform, ctx, "discover", []);
    const sessions = listHarnessSessions(paths, cwd);
    expect(sessions.length).toBe(1);
    const sid = sessions[0];

    const discover = loadHarnessDiscover(paths, cwd, sid);
    expect(discover.ok).toBe(true);

    // Step 2: research. Subsequent subcommands resolve the most-recent session.
    await handleStageCommand(platform, ctx, "research", []);
    const researchDir = getHarnessResearchDir(paths, cwd, sid);
    expect(fs.existsSync(researchDir)).toBe(true);
    const topics = fs.readdirSync(researchDir);
    expect(topics.length).toBeGreaterThan(0);

    // Step 3: design. Auto-derives a spec from discover and persists both md + json.
    await handleStageCommand(platform, ctx, "design", []);
    const specMdPath = getHarnessDesignSpecPath(paths, cwd, sid);
    expect(fs.existsSync(specMdPath)).toBe(true);
    const specJson = loadHarnessDesignSpecJson(paths, cwd, sid);
    expect(specJson.ok).toBe(true);
    if (specJson.ok) {
      expect(specJson.value.sessionId).toBe(sid);
    }

    // Step 4: plan-draft. Emits the canonical plan markdown.
    await handleHarness(platform, ctx, "plan-draft");
    const plansDir = getProjectStatePath(paths, cwd, "plans");
    const planPath = path.join(plansDir, `harness-${sid}.md`);
    expect(fs.existsSync(planPath)).toBe(true);

    // Auto mode now stops at the implement handoff so the saved plan can be
    // executed by the active agent before validation inspects generated files.
  });
  test("implement subcommand hands the saved plan to the active agent", async () => {
    const platform = makePlatform();
    const ctx = makeCtx();

    // Drive the chain up to plan so implement has a plan file.
    await handleStageCommand(platform, ctx, "discover", []);
    const sid = listHarnessSessions(paths, cwd)[0];
    await handleStageCommand(platform, ctx, "design", []);
    await handleHarness(platform, ctx, "plan-draft");

    // Snapshot notifications to isolate implement's output.
    const before = ctx.notifications.length;
    await handleStageCommand(platform, ctx, "implement", []);
    const newNotes = ctx.notifications.slice(before);
    // Implement runs through the pipeline and hands the saved plan to the active
    // agent. We assert at least one notification was emitted.
    expect(newNotes.length).toBeGreaterThan(0);
    expect(sid).toMatch(/^harness-/);
  });

  test("validate subcommand drives the validate stage end-to-end", async () => {
    const platform = makePlatform();
    const ctx = makeCtx();

    await handleStageCommand(platform, ctx, "discover", []);
    const sid = listHarnessSessions(paths, cwd)[0];
    await handleStageCommand(platform, ctx, "design", []);
    await handleStageCommand(platform, ctx, "validate", []);

    // Validate persists a report regardless of pass/fail; the file should now exist.
    const reportPath = getHarnessValidateReportPath(paths, cwd, sid);
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(getHarnessSessionDir(paths, cwd, sid))).toBe(true);
  });
});
