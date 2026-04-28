import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UltraPlanIndex } from "../../src/types.js";
import {
  getUltraplanActiveBatchRunPath,
  getUltraplanAuthoredJsonPath,
  getUltraplanBatchRunPath,
  getUltraplanIndexPath,
  getUltraplanManifestPath,
  getUltraplanMigrationRecordPath,
  getUltraplanSessionDir,
} from "../../src/ultraplan/project-paths.js";
import {
  abandonUltraPlanBatchForTesting,
  abandonUltraPlanBatchNodeForTesting,
  loadVisibleSessionsForTesting,
  planUltraPlanBatchRunForTesting,
  renderUltraPlanBatchStatusForTesting,
  resolveUltraPlanRunBatchStateForTesting,
  resumeUltraPlanBatchRunForTesting,
} from "../../src/commands/ultraplan.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanBatchActiveRunLease,
  makeUltraPlanBatchNode,
  makeUltraPlanBatchRun,
  makeUltraPlanManifest,
  seedLegacyRepoLocalSession,
} from "../ultraplan/fixtures.js";

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-cmd-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function seedGlobalIndex(paths: ReturnType<typeof createTestPaths>, cwd: string, index: UltraPlanIndex): void {
  const indexPath = getUltraplanIndexPath(paths, cwd);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}


function seedCanonicalGlobalSession(
  paths: ReturnType<typeof createTestPaths>,
  cwd: string,
  sessionId: string,
): void {
  const dir = getUltraplanSessionDir(paths, cwd, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    getUltraplanAuthoredJsonPath(paths, cwd, sessionId),
    `${JSON.stringify(makeUltraPlanAuthored({ sessionId }), null, 2)}\n`,
  );
  fs.writeFileSync(
    getUltraplanManifestPath(paths, cwd, sessionId),
    `${JSON.stringify(makeUltraPlanManifest({ sessionId }), null, 2)}\n`,
  );
}

describe("loadVisibleSessions — migration integration", () => {
  test("native global session loads successfully and reports no migration failures", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    seedCanonicalGlobalSession(paths, cwd, "up-native");
    seedGlobalIndex(paths, cwd, {
      sessions: [{
        sessionId: "up-native",
        title: "Auth slice",
        state: "ready",
        bucket: "pending",
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        cursor: null,
        idleReason: null,
      }],
    });

    const result = loadVisibleSessionsForTesting({ platform: { paths } as any, cwd });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.sessions.length).toBe(1);
      expect(result.failures.length).toBe(0);
    }
  });

  test("migration-unsafe outcome folds into failures via formatVisibleSessionFailure", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-broken";

    // Seed a partial global directory (authored only — manifest missing) and no legacy copy.
    // The migration engine classifies this as branch 7 and emits a migration-unsafe blocker.
    const sessionDir = getUltraplanSessionDir(paths, cwd, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      getUltraplanAuthoredJsonPath(paths, cwd, sessionId),
      `${JSON.stringify(makeUltraPlanAuthored({ sessionId }), null, 2)}\n`,
    );
    seedGlobalIndex(paths, cwd, {
      sessions: [{
        sessionId,
        title: "Broken session",
        state: "ready",
        bucket: "pending",
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        cursor: null,
        idleReason: null,
      }],
    });

    const result = loadVisibleSessionsForTesting({ platform: { paths } as any, cwd });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.failures.length).toBe(1);
      expect(result.failures[0].sessionId).toBe(sessionId);
      expect(result.failures[0].message).toContain(sessionId);
      expect(result.failures[0].message.toLowerCase()).toContain("migration-unsafe");
    }
  });

  test("legacy-only session migrates automatically and appears as an ok session", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-legacy";
    seedLegacyRepoLocalSession(cwd, sessionId, {
      authored: makeUltraPlanAuthored({ sessionId }),
      manifest: makeUltraPlanManifest({ sessionId }),
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [{
        sessionId,
        title: "Legacy session",
        state: "ready",
        bucket: "pending",
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        cursor: null,
        idleReason: null,
      }],
    });

    const result = loadVisibleSessionsForTesting({ platform: { paths } as any, cwd });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.sessions.length).toBe(1);
      expect(result.failures.length).toBe(0);
    }
    // migration.json was written.
    expect(fs.existsSync(getUltraplanMigrationRecordPath(paths, cwd, sessionId))).toBe(true);
  });
});


import { handleUltraplan } from "../../src/commands/ultraplan.js";
import { mock } from "bun:test";

function createUltraplanCtx(overrides: {
  hasUI?: boolean;
  selectResponses?: Array<string | null>;
  selectIndexes?: Array<number | null>;
  inputResponses?: Array<string | null>;
  pickFirstSelect?: boolean;
  setStatus?: ((key: string, value: string | undefined) => unknown) | null;
  setWidget?: ((name: string, value: unknown) => unknown) | null;
} = {}) {
  const selectResponses = overrides.selectResponses ?? [];
  const selectIndexes = overrides.selectIndexes ?? [];
  const inputResponses = overrides.inputResponses ?? [];
  let sIdx = 0;
  let iIdx = 0;
  const select = mock(async (_title?: string, options?: string[]) => {
    const explicit = selectResponses[sIdx] ?? null;
    const selectedIndex = selectIndexes[sIdx] ?? null;
    const isRunModePrompt = Array.isArray(options)
      && options.length === 3
      && options[0] === "Single session"
      && options[1] === "Batch sessions"
      && options[2] === "Cancel";
    if (explicit !== null) {
      sIdx += 1;
      return explicit;
    }
    if (isRunModePrompt) {
      return options[0];
    }
    if (selectedIndex !== null && Array.isArray(options) && options[selectedIndex]) {
      sIdx += 1;
      return options[selectedIndex];
    }
    if (overrides.pickFirstSelect && Array.isArray(options) && options.length > 0) {
      sIdx += 1;
      return options[0];
    }
    sIdx += 1;
    return null;
  });
  const input = mock(async () => {
    const v = inputResponses[iIdx] ?? null;
    iIdx += 1;
    return v;
  });
  const notify = mock(() => {});
  const confirm = mock(async () => true);
  const setStatus = overrides.setStatus ? mock(overrides.setStatus) : undefined;
  const setWidget = overrides.setWidget ? mock(overrides.setWidget) : undefined;
  const ui: Record<string, unknown> = { select, input, notify, confirm };
  if (setStatus) ui.setStatus = setStatus;
  if (setWidget) ui.setWidget = setWidget;

  return {
    cwd: "",
    hasUI: overrides.hasUI ?? true,
    ui,
    select, input, notify, confirm, setStatus, setWidget,
  };
}

function pickerLabels(ctx: ReturnType<typeof createUltraplanCtx>, callIndex = 0): string[] {
  let options = ctx.select.mock.calls[callIndex]?.[1] as string[] | undefined;
  if (callIndex === 0
    && Array.isArray(options)
    && options.length === 3
    && options[0] === "Single session"
    && options[1] === "Batch sessions"
    && options[2] === "Cancel") {
    options = ctx.select.mock.calls[1]?.[1] as string[] | undefined;
  }
  return (options ?? []).map((option) => option.split(" — ")[0]);
}

function createBatchExecMock(repoRoot: string) {
  return mock(async (_cmd: string, args: string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { stdout: `${repoRoot}\n`, stderr: "", code: 0 };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { stdout: "sha-head\n", stderr: "", code: 0 };
    }
    if (args[0] === "symbolic-ref" && args[1] === "refs/remotes/origin/HEAD") {
      return { stdout: "refs/remotes/origin/main\n", stderr: "", code: 0 };
    }
    if (args[0] === "config" && args[1] === "init.defaultBranch") {
      return { stdout: "main\n", stderr: "", code: 0 };
    }
    if (args[0] === "show-ref") {
      return { stdout: "", stderr: "", code: 1 };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      const worktreePath = args[2] === "-b" ? args[4]! : args[2]!;
      const worktreeName = path.basename(worktreePath);
      const worktreeGitDir = path.join(repoRoot, ".git", "worktrees", worktreeName);
      fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.mkdirSync(worktreeGitDir, { recursive: true });
      fs.writeFileSync(path.join(worktreePath, "package.json"), JSON.stringify({ name: path.basename(repoRoot) }), "utf8");
      fs.writeFileSync(path.join(worktreePath, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
      fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: `unsupported git command: ${args.join(" ")}`, code: 1 };
  });
}

function updateManifest(
  paths: ReturnType<typeof createTestPaths>,
  cwd: string,
  sessionId: string,
  mutate: (manifest: any) => void,
  updatedAt = "2026-04-19T12:05:00.000Z",
): void {
  const manifestPath = getUltraplanManifestPath(paths, cwd, sessionId);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  mutate(manifest);
  manifest.updatedAt = updatedAt;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function updateAuthored(
  paths: ReturnType<typeof createTestPaths>,
  cwd: string,
  sessionId: string,
  mutate: (authored: any) => void,
  updatedAt = "2026-04-19T12:05:00.000Z",
): void {
  const authoredPath = getUltraplanAuthoredJsonPath(paths, cwd, sessionId);
  const authored = JSON.parse(fs.readFileSync(authoredPath, "utf8"));
  mutate(authored);
  authored.updatedAt = updatedAt;
  fs.writeFileSync(authoredPath, `${JSON.stringify(authored, null, 2)}\n`);
}

describe("handleUltraplan conversational authoring", () => {
  test("undefined args starts agent-driven authoring without TUI prompts", async () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sendMessage = mock(() => {});
    const platform = { paths, sendMessage } as any;
    const ctx = createUltraplanCtx({ hasUI: true, inputResponses: [null] });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, undefined);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = sendMessage.mock.calls[0] as any[];
    expect(message.customType).toBe("supi-ultraplan-author");
    expect(message.display).toBe("none");
    expect(String(message.content[0].text)).toContain("No initial prompt was provided");
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(ctx.input).not.toHaveBeenCalled();
    expect(ctx.select).not.toHaveBeenCalled();
  });

  test("hasUI:false still starts chat authoring instead of warning", async () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sendMessage = mock(() => {});
    const platform = { paths, sendMessage } as any;
    const ctx = createUltraplanCtx({ hasUI: false });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, undefined);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const warnings = ctx.notify.mock.calls.filter((c: unknown[]) => c[1] === "warning");
    expect(warnings).toHaveLength(0);
  });

  test("non-subcommand args are treated as the initial user prompt", async () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sendMessage = mock(() => {});
    const platform = { paths, sendMessage } as any;
    const ctx = createUltraplanCtx({ hasUI: true });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "redesign checkout for mobile");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [message] = sendMessage.mock.calls[0] as any[];
    const prompt = String(message.content[0].text);
    expect(prompt).toContain("Initial user prompt (verbatim)");
    expect(prompt).toContain("redesign checkout for mobile");
    expect(prompt).toContain("ultraplan_create");
    expect(ctx.input).not.toHaveBeenCalled();
  });

  test("empty-string args routes identically to undefined", async () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sendMessage = mock(() => {});
    const platform = { paths, sendMessage } as any;
    const ctx = createUltraplanCtx({ hasUI: true, inputResponses: [null] });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [message] = sendMessage.mock.calls[0] as any[];
    expect(String(message.content[0].text)).toContain("No initial prompt was provided");
    expect(ctx.input).not.toHaveBeenCalled();
  });
});

describe("handleUltraplan regressions", () => {
  test("/supi:ultraplan next requires interactive mode", async () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: false });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "next");

    const warnings = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "warning");
    const warning = warnings[0] as unknown[] | undefined;
    expect(warnings).toHaveLength(1);
    expect(String(warning?.[0] ?? "")).toContain("Ultraplan next requires interactive mode");
    expect(ctx.select).not.toHaveBeenCalled();
  });

  test("subcommand-completions list is unchanged (run, status, next)", async () => {
    // Load the command registration and verify the SUBCOMMANDS list shape via the registered handler
    const calls: Array<{ name: string; opts: any }> = [];
    const platform = {
      paths: createTestPaths(tmpDir),
      registerCommand(name: string, opts: any) { calls.push({ name, opts }); },
    } as any;
    const { registerUltraplanCommand } = await import("../../src/commands/ultraplan.js");
    registerUltraplanCommand(platform);
    const registered = calls.find((c) => c.name === "supi:ultraplan");
    expect(registered).toBeDefined();
    const completions = registered!.opts.getArgumentCompletions("");
    expect(completions).toEqual([
      { value: "run ", label: "run", description: "Run a session or start/resume a batch" },
      { value: "status ", label: "status", description: "Inspect status for an existing ultraplan session" },
      { value: "next ", label: "next", description: "Recommend the next ultraplan session to run" }
    ]);
  });
});

describe("handleUltraplan next command", () => {
  test("next presents the top runnable recommendation and requires an explicit run confirmation", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-next-pending";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    updateManifest(paths, cwd, sessionId, (manifest) => {
      manifest.title = "Pending session";
      manifest.state = "ready";
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId, title: "Pending session", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const prompt = mock(async () => {
      updateManifest(paths, cwd, sessionId, (manifest) => {
        manifest.state = "blocked";
        manifest.blocker = {
          code: "proof-missing",
          message: "Need the red-phase proof",
          scope: "scenario",
          affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "scenario-a" },
          recoverable: true,
          recoveryMode: "retry",
          nextAction: "Rerun the proof",
          retryable: true,
          detectedAt: "2026-04-19T12:05:00.000Z",
        };
      });
    });
    const dispose = mock(async () => {});
    const platform = {
      paths,
      createAgentSession: mock(async () => ({ prompt, dispose, subscribe: () => () => {}, state: { messages: [] } })),
    } as any;
    const ctx = createUltraplanCtx({ hasUI: true, selectIndexes: [0] });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "next");

    expect(String(ctx.select.mock.calls[0]?.[0] ?? "")).toContain(
      "Recommended next: Pending session — ready to run.",
    );
    expect(ctx.select.mock.calls[0]?.[1]).toEqual(["Run this session", "Inspect session", "Choose another session", "Cancel"]);
    expect(platform.createAgentSession).toHaveBeenCalledTimes(1);
  });

  test("next can inspect a runnable recommendation without dispatching", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-next-inspect-runnable";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    updateManifest(paths, cwd, sessionId, (manifest) => {
      manifest.title = "Inspectable runnable session";
      manifest.state = "ready";
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId, title: "Inspectable runnable session", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const platform = {
      paths,
      createAgentSession: mock(async () => { throw new Error("runner should not dispatch when inspecting"); }),
    } as any;
    const ctx = createUltraplanCtx({ hasUI: true, selectResponses: ["Inspect session"] });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "next");

    expect(platform.createAgentSession).not.toHaveBeenCalled();
    const infos = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "info");
    const lastInfo = infos[infos.length - 1] as unknown[] | undefined;
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan status");
    expect(String(lastInfo?.[0] ?? "")).toContain("State: ready");
  });

  test("next presents inspect-only recommendations without dispatching the runner", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-next-awaiting";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    updateManifest(paths, cwd, sessionId, (manifest) => {
      manifest.title = "Awaiting session";
      manifest.state = "awaiting-user";
      manifest.blocker = {
        code: "blocked",
        message: "Need product sign-off",
        scope: "session",
        affected: { stack: null, domainId: null, level: null, scenarioId: null },
        recoverable: false,
        recoveryMode: "await-user",
        nextAction: "Wait for sign-off",
        retryable: false,
        detectedAt: "2026-04-19T12:05:00.000Z",
      };
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId, title: "Awaiting session", state: "awaiting-user", bucket: "idle", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: "Need product sign-off" },
      ],
    });

    const platform = {
      paths,
      createAgentSession: mock(async () => {
        throw new Error("runner should not dispatch for inspect-only next recommendations");
      }),
    } as any;
    const ctx = createUltraplanCtx({ hasUI: true, selectIndexes: [0] });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "next");

    expect(String(ctx.select.mock.calls[0]?.[0] ?? "")).toContain(
      "Recommended next: Awaiting session — inspect it first; user input is required.",
    );
    expect(ctx.select.mock.calls[0]?.[1]).toEqual(["Inspect session", "Choose another session", "Cancel"]);
    expect(platform.createAgentSession).not.toHaveBeenCalled();
    const infos = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "info");
    const lastInfo = infos[infos.length - 1] as unknown[] | undefined;
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan status");
  });

  test("next can reopen the shared picker and reconfirm before running another runnable session", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionIds = {
      ongoing: "up-next-ongoing",
      pending: "up-next-pending-alt",
    } as const;

    for (const sessionId of Object.values(sessionIds)) {
      seedCanonicalGlobalSession(paths, cwd, sessionId);
    }
    updateManifest(paths, cwd, sessionIds.ongoing, (manifest) => {
      manifest.title = "Ongoing session";
      manifest.state = "running";
    });
    updateManifest(paths, cwd, sessionIds.pending, (manifest) => {
      manifest.title = "Pending alternative";
      manifest.state = "ready";
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId: sessionIds.pending, title: "Pending alternative", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
        { sessionId: sessionIds.ongoing, title: "Ongoing session", state: "running", bucket: "ongoing", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const prompt = mock(async () => {
      updateManifest(paths, cwd, sessionIds.pending, (manifest) => {
        manifest.state = "blocked";
        manifest.blocker = {
          code: "proof-missing",
          message: "Need the pending proof",
          scope: "scenario",
          affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "scenario-a" },
          recoverable: true,
          recoveryMode: "retry",
          nextAction: "Rerun the proof",
          retryable: true,
          detectedAt: "2026-04-19T12:05:00.000Z",
        };
      });
    });
    const dispose = mock(async () => {});
    const platform = {
      paths,
      createAgentSession: mock(async () => ({ prompt, dispose, subscribe: () => () => {}, state: { messages: [] } })),
    } as any;
    const ctx = createUltraplanCtx({ selectResponses: ["Choose another session"], hasUI: true, selectIndexes: [0, 1, 0] });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "next");

    expect(ctx.select).toHaveBeenCalledTimes(3);
    expect(String(ctx.select.mock.calls[2]?.[0] ?? "")).toContain(
      "Recommended next: Pending alternative — ready to run.",
    );
    expect(ctx.select.mock.calls[2]?.[1]).toEqual(["Run this session", "Inspect session", "Cancel"]);
    expect(platform.createAgentSession).toHaveBeenCalledTimes(1);
  });

  test("next opens detailed status when choose-another picks an inspect-only alternative", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionIds = {
      ongoing: "up-next-ongoing-alt",
      awaiting: "up-next-awaiting-alt",
    } as const;

    for (const sessionId of Object.values(sessionIds)) {
      seedCanonicalGlobalSession(paths, cwd, sessionId);
    }
    updateManifest(paths, cwd, sessionIds.ongoing, (manifest) => {
      manifest.title = "Ongoing session";
      manifest.state = "running";
    });
    updateManifest(paths, cwd, sessionIds.awaiting, (manifest) => {
      manifest.title = "Awaiting alternative";
      manifest.state = "awaiting-user";
      manifest.blocker = {
        code: "blocked",
        message: "Need product sign-off",
        scope: "session",
        affected: { stack: null, domainId: null, level: null, scenarioId: null },
        recoverable: false,
        recoveryMode: "await-user",
        nextAction: "Wait for sign-off",
        retryable: false,
        detectedAt: "2026-04-19T12:05:00.000Z",
      };
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId: sessionIds.awaiting, title: "Awaiting alternative", state: "awaiting-user", bucket: "idle", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: "Need product sign-off" },
        { sessionId: sessionIds.ongoing, title: "Ongoing session", state: "running", bucket: "ongoing", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const platform = {
      paths,
      createAgentSession: mock(async () => {
        throw new Error("runner should not dispatch when choose-another selects an inspect-only session");
      }),
    } as any;
    const ctx = createUltraplanCtx({ selectResponses: ["Choose another session"], hasUI: true, selectIndexes: [0, 1] });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "next");

    expect(ctx.select).toHaveBeenCalledTimes(2);
    expect(platform.createAgentSession).not.toHaveBeenCalled();
    const infos = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "info");
    const lastInfo = infos[infos.length - 1] as unknown[] | undefined;
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan status");
  });
});


describe("handleUltraplan status-surface projection", () => {
  test("projects the compact recommendation to setStatus when only setStatus is available", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-surface-status-only";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    updateManifest(paths, cwd, sessionId, (manifest) => {
      manifest.title = "Pending session";
      manifest.state = "ready";
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId, title: "Pending session", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: true, setStatus: () => undefined });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(ctx.setStatus).toHaveBeenCalledWith("supi-ultraplan-next", "Ultraplan next: Pending session — ready to run");
  });

  test("projects the compact recommendation to setWidget when only setWidget is available", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-surface-widget-only";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    updateManifest(paths, cwd, sessionId, (manifest) => {
      manifest.title = "Pending session";
      manifest.state = "ready";
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId, title: "Pending session", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: true, setWidget: () => undefined });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(ctx.setWidget).toHaveBeenCalledWith("supi-ultraplan-next", "Ultraplan next: Pending session — ready to run");
  });

  test("mirrors the same summary to both surfaces when setStatus and setWidget are both available", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-surface-both";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    updateManifest(paths, cwd, sessionId, (manifest) => {
      manifest.title = "Pending session";
      manifest.state = "ready";
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId, title: "Pending session", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const platform = { paths } as any;
    const ctx = createUltraplanCtx({
      hasUI: true,
      setStatus: () => undefined,
      setWidget: () => undefined,
    });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(ctx.setStatus).toHaveBeenCalledWith("supi-ultraplan-next", "Ultraplan next: Pending session — ready to run");
    expect(ctx.setWidget).toHaveBeenCalledWith("supi-ultraplan-next", "Ultraplan next: Pending session — ready to run");
  });

  test("leaves command behavior unchanged when no projection surfaces exist", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-surface-none";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    updateManifest(paths, cwd, sessionId, (manifest) => {
      manifest.title = "Pending session";
      manifest.state = "ready";
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId, title: "Pending session", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: true });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(ctx.select).toHaveBeenCalledTimes(1);
    expect(ctx.setStatus).toBeUndefined();
    expect(ctx.setWidget).toBeUndefined();
  });

  test("clears available surfaces when no valid recommendation exists", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-surface-done-only";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    updateManifest(paths, cwd, sessionId, (manifest) => {
      manifest.title = "Done session";
      manifest.state = "discarded";
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId, title: "Done session", state: "discarded", bucket: "done", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const platform = { paths } as any;
    const ctx = createUltraplanCtx({
      hasUI: true,
      setStatus: () => undefined,
      setWidget: () => undefined,
    });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "status");

    expect(ctx.setStatus).toHaveBeenCalledWith("supi-ultraplan-next", undefined);
    expect(ctx.setWidget).toHaveBeenCalledWith("supi-ultraplan-next", undefined);
  });

  test("swallows projection errors without breaking the interactive command", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-surface-throws";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    updateManifest(paths, cwd, sessionId, (manifest) => {
      manifest.title = "Pending session";
      manifest.state = "ready";
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId, title: "Pending session", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const platform = { paths } as any;
    const ctx = createUltraplanCtx({
      hasUI: true,
      setStatus: () => { throw new Error("setStatus failed"); },
      setWidget: () => undefined,
    });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(ctx.setWidget).toHaveBeenCalledWith("supi-ultraplan-next", "Ultraplan next: Pending session — ready to run");
    expect(ctx.select).toHaveBeenCalledTimes(1);
  });
});
describe("handleUltraplan run command", () => {
  test("run invokes the session runner after selection and renders the paused outcome", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-run-pause";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    seedGlobalIndex(paths, cwd, {
      sessions: [{
        sessionId,
        title: "Runnable session",
        state: "ready",
        bucket: "pending",
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        cursor: null,
        idleReason: null,
      }],
    });

    const prompt = mock(async () => {
      const manifestPath = getUltraplanManifestPath(paths, cwd, sessionId);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.state = "blocked";
      manifest.blocker = {
        code: "proof-missing",
        message: "Need the red-phase proof",
        scope: "scenario",
        affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "scenario-a" },
        recoverable: true,
        recoveryMode: "retry",
        nextAction: "Rerun the proof",
        retryable: true,
        detectedAt: "2026-04-19T12:05:00.000Z",
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    });
    const dispose = mock(async () => {});
    const platform = {
      paths,
      createAgentSession: mock(async () => ({ prompt, dispose, subscribe: () => () => {}, state: { messages: [] } })),
    } as any;
    const ctx = createUltraplanCtx({ hasUI: true, pickFirstSelect: true });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(platform.createAgentSession).toHaveBeenCalledTimes(1);
    const infos = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "info");
    const lastInfo = infos[infos.length - 1] as unknown[] | undefined;
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan paused");
    expect(String(lastInfo?.[0] ?? "")).toContain("Need the red-phase proof");
  });

  test("run renders the completed outcome when the dispatched attempt finishes the session", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-run-complete";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    seedGlobalIndex(paths, cwd, {
      sessions: [{
        sessionId,
        title: "Runnable session",
        state: "ready",
        bucket: "pending",
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        cursor: null,
        idleReason: null,
      }],
    });

    const prompt = mock(async () => {
      const authoredPath = getUltraplanAuthoredJsonPath(paths, cwd, sessionId);
      const authored = JSON.parse(fs.readFileSync(authoredPath, "utf8"));
      authored.stacks[0].agentSlots.domainReviewEnabled = false;
      authored.stacks[0].agentSlots.stackReviewEnabled = false;
      authored.stacks[0].domains[0].review.enabled = false;
      for (const scenario of authored.stacks[0].domains[0].unit) {
        scenario.status = "done";
        scenario.proofs = [{
          type: "artifact",
          phase: "complete",
          recordedAt: "2026-04-19T12:05:00.000Z",
          actor: "frontend-executor",
          evidence: { summary: `Completed ${scenario.id}` },
          artifactRef: `artifact://${scenario.id}-complete`,
        }];
      }
      fs.writeFileSync(authoredPath, `${JSON.stringify(authored, null, 2)}\n`);
    });
    const dispose = mock(async () => {});
    const platform = {
      paths,
      createAgentSession: mock(async () => ({ prompt, dispose, subscribe: () => () => {}, state: { messages: [] } })),
    } as any;
    const ctx = createUltraplanCtx({ hasUI: true, pickFirstSelect: true });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(platform.createAgentSession).toHaveBeenCalledTimes(1);
    const infos = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "info");
    const lastInfo = infos[infos.length - 1] as unknown[] | undefined;
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan complete");
    expect(String(lastInfo?.[0] ?? "")).toContain("Current: Session complete");
  });

  test("pre-run inspect-only sessions render detailed status without dispatching", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-preblocked";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    const manifestPath = getUltraplanManifestPath(paths, cwd, sessionId);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.state = "blocked";
    manifest.blocker = {
      code: "proof-missing",
      message: "Need the failing proof before resume",
      scope: "scenario",
      affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "scenario-a" },
      recoverable: true,
      recoveryMode: "retry",
      nextAction: "Retry the proof",
      retryable: true,
      detectedAt: "2026-04-19T12:05:00.000Z",
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    seedGlobalIndex(paths, cwd, {
      sessions: [{
        sessionId,
        title: "Blocked session",
        state: "blocked",
        bucket: "idle",
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:05:00.000Z",
        cursor: manifest.cursor,
        idleReason: "Need the failing proof before resume",
      }],
    });

    const platform = {
      paths,
      createAgentSession: mock(async () => {
        throw new Error("runner should not dispatch a blocked session");
      }),
    } as any;
    const ctx = createUltraplanCtx({ hasUI: true, pickFirstSelect: true });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(platform.createAgentSession).not.toHaveBeenCalled();
    const infos = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "info");
    const lastInfo = infos[infos.length - 1] as unknown[] | undefined;
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan status");
    expect(String(lastInfo?.[0] ?? "")).toContain("Idle reason: Need the failing proof before resume");
  });


  test("run picker orders runnable sessions before inspect-only sessions", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionIds = {
      awaiting: "up-run-awaiting",
      pending: "up-run-pending",
      ongoing: "up-run-ongoing",
    } as const;

    for (const sessionId of Object.values(sessionIds)) {
      seedCanonicalGlobalSession(paths, cwd, sessionId);
    }

    updateManifest(paths, cwd, sessionIds.awaiting, (manifest) => {
      manifest.title = "Awaiting session";
      manifest.state = "awaiting-user";
      manifest.blocker = {
        code: "blocked",
        message: "Need product sign-off",
        scope: "session",
        affected: { stack: null, domainId: null, level: null, scenarioId: null },
        recoverable: false,
        recoveryMode: "await-user",
        nextAction: "Wait for sign-off",
        retryable: false,
        detectedAt: "2026-04-19T12:05:00.000Z",
      };
    });
    updateManifest(paths, cwd, sessionIds.pending, (manifest) => {
      manifest.title = "Pending session";
      manifest.state = "ready";
    });
    updateManifest(paths, cwd, sessionIds.ongoing, (manifest) => {
      manifest.title = "Ongoing session";
      manifest.state = "running";
    });

    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId: sessionIds.awaiting, title: "Awaiting session", state: "awaiting-user", bucket: "idle", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: "Need product sign-off" },
        { sessionId: sessionIds.pending, title: "Pending session", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
        { sessionId: sessionIds.ongoing, title: "Ongoing session", state: "running", bucket: "ongoing", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: true });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(pickerLabels(ctx)).toEqual([
      "[ongoing] Ongoing session",
      "[pending] Pending session",
      "[idle] Awaiting session",
    ]);
  });

  test("run routes inspect-only selections through detailed status instead of dispatching the runner", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionIds = {
      awaiting: "up-run-inspect-awaiting",
      pending: "up-run-inspect-pending",
    } as const;

    for (const sessionId of Object.values(sessionIds)) {
      seedCanonicalGlobalSession(paths, cwd, sessionId);
    }

    updateManifest(paths, cwd, sessionIds.awaiting, (manifest) => {
      manifest.title = "Awaiting session";
      manifest.state = "awaiting-user";
      manifest.blocker = {
        code: "blocked",
        message: "Need product sign-off",
        scope: "session",
        affected: { stack: null, domainId: null, level: null, scenarioId: null },
        recoverable: false,
        recoveryMode: "await-user",
        nextAction: "Wait for sign-off",
        retryable: false,
        detectedAt: "2026-04-19T12:05:00.000Z",
      };
    });
    updateManifest(paths, cwd, sessionIds.pending, (manifest) => {
      manifest.title = "Pending session";
      manifest.state = "ready";
    });

    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId: sessionIds.awaiting, title: "Awaiting session", state: "awaiting-user", bucket: "idle", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: "Need product sign-off" },
        { sessionId: sessionIds.pending, title: "Pending session", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const platform = {
      paths,
      createAgentSession: mock(async () => {
        throw new Error("runner should not dispatch when an inspect-only option is chosen");
      }),
    } as any;
    const ctx = createUltraplanCtx({ hasUI: true, selectIndexes: [1] });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(platform.createAgentSession).not.toHaveBeenCalled();
    const infos = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "info");
    const lastInfo = infos[infos.length - 1] as unknown[] | undefined;
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan status");
    expect(String(lastInfo?.[0] ?? "")).toContain("Idle reason: Awaiting user: Need product sign-off");
  });


  test("run still dispatches when the selected shared-picker entry is runnable", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionIds = {
      awaiting: "up-run-runnable-awaiting",
      pending: "up-run-runnable-pending",
    } as const;

    for (const sessionId of Object.values(sessionIds)) {
      seedCanonicalGlobalSession(paths, cwd, sessionId);
    }

    updateManifest(paths, cwd, sessionIds.awaiting, (manifest) => {
      manifest.title = "Awaiting session";
      manifest.state = "awaiting-user";
      manifest.blocker = {
        code: "blocked",
        message: "Need product sign-off",
        scope: "session",
        affected: { stack: null, domainId: null, level: null, scenarioId: null },
        recoverable: false,
        recoveryMode: "await-user",
        nextAction: "Wait for sign-off",
        retryable: false,
        detectedAt: "2026-04-19T12:05:00.000Z",
      };
    });
    updateManifest(paths, cwd, sessionIds.pending, (manifest) => {
      manifest.title = "Pending session";
      manifest.state = "ready";
    });

    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId: sessionIds.awaiting, title: "Awaiting session", state: "awaiting-user", bucket: "idle", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: "Need product sign-off" },
        { sessionId: sessionIds.pending, title: "Pending session", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const prompt = mock(async () => {
      updateManifest(paths, cwd, sessionIds.pending, (manifest) => {
        manifest.state = "blocked";
        manifest.blocker = {
          code: "proof-missing",
          message: "Need the red-phase proof",
          scope: "scenario",
          affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "scenario-a" },
          recoverable: true,
          recoveryMode: "retry",
          nextAction: "Rerun the proof",
          retryable: true,
          detectedAt: "2026-04-19T12:05:00.000Z",
        };
      });
    });
    const dispose = mock(async () => {});
    const platform = {
      paths,
      createAgentSession: mock(async () => ({ prompt, dispose, subscribe: () => () => {}, state: { messages: [] } })),
    } as any;
    const ctx = createUltraplanCtx({ hasUI: true, selectIndexes: [0] });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(platform.createAgentSession).toHaveBeenCalledTimes(1);
    const infos = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "info");
    const lastInfo = infos[infos.length - 1] as unknown[] | undefined;
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan paused");
    expect(String(lastInfo?.[0] ?? "")).toContain("Need the red-phase proof");
  });

  test("run exposes a single-session-or-batch choice when no active batch exists", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);

    expect(resolveUltraPlanRunBatchStateForTesting({ paths, cwd })).toEqual({ kind: "single-or-batch" });
  });

  test("run resolves an active batch resume surface when a live lease exists", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const run = makeUltraPlanBatchRun({ runId: "batch-active" });
    const lease = makeUltraPlanBatchActiveRunLease({ runId: run.runId });
    const activeRunPath = getUltraplanActiveBatchRunPath(paths, cwd);
    const runPath = getUltraplanBatchRunPath(paths, cwd, run.runId);
    fs.mkdirSync(path.dirname(activeRunPath), { recursive: true });
    fs.mkdirSync(path.dirname(runPath), { recursive: true });
    fs.writeFileSync(activeRunPath, `${JSON.stringify(lease, null, 2)}\n`);
    fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);

    const result = resolveUltraPlanRunBatchStateForTesting({ paths, cwd });
    expect(result.kind).toBe("resume-batch");
    if (result.kind === "resume-batch") {
      expect(result.run.runId).toBe(run.runId);
    }
  });

  test("run surfaces invalid-run guidance when active-run or run.json truth is broken", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const activeRunPath = getUltraplanActiveBatchRunPath(paths, cwd);
    fs.mkdirSync(path.dirname(activeRunPath), { recursive: true });
    fs.writeFileSync(activeRunPath, "{not-json");

    const brokenLease = resolveUltraPlanRunBatchStateForTesting({ paths, cwd });
    expect(brokenLease.kind).toBe("invalid-run");
    if (brokenLease.kind === "invalid-run") {
      expect(brokenLease.message).toContain("invalid-run");
    }

    const run = makeUltraPlanBatchRun({ runId: "batch-missing" });
    fs.writeFileSync(activeRunPath, `${JSON.stringify(makeUltraPlanBatchActiveRunLease({ runId: run.runId }), null, 2)}\n`);
    const missingRun = resolveUltraPlanRunBatchStateForTesting({ paths, cwd });
    expect(missingRun.kind).toBe("invalid-run");
  });

  test("run can plan a batch and persist run.json before execution starts", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionIds = ["up-batch-a", "up-batch-b"] as const;
    for (const sessionId of sessionIds) {
      seedCanonicalGlobalSession(paths, cwd, sessionId);
    }
    seedGlobalIndex(paths, cwd, {
      sessions: sessionIds.map((sessionId) => ({
        sessionId,
        title: sessionId,
        state: "ready",
        bucket: "pending",
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        cursor: null,
        idleReason: null,
      })),
    });

    const run = planUltraPlanBatchRunForTesting({
      paths,
      cwd,
      sessionIds: [...sessionIds],
      maxParallelism: 2,
    });

    expect(fs.existsSync(getUltraplanBatchRunPath(paths, cwd, run.runId))).toBe(true);
    expect(run.maxParallelism).toBe(2);
    expect(run.nodes.map((node) => node.sessionId)).toEqual([...sessionIds]);
    expect(fs.existsSync(getUltraplanActiveBatchRunPath(paths, cwd))).toBe(false);
  });

  test("run starts real batch supervision when batch mode is selected", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionIds = ["up-batch-a", "up-batch-b"] as const;
    for (const sessionId of sessionIds) {
      seedCanonicalGlobalSession(paths, cwd, sessionId);
    }
    updateManifest(paths, cwd, sessionIds[0], (manifest) => { manifest.title = "Batch Alpha"; manifest.state = "ready"; });
    updateManifest(paths, cwd, sessionIds[1], (manifest) => { manifest.title = "Batch Beta"; manifest.state = "ready"; });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId: sessionIds[0], title: "Batch Alpha", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:00:00.000Z", cursor: null, idleReason: null },
        { sessionId: sessionIds[1], title: "Batch Beta", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:00:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const createAgentSession = mock(async (opts: any) => {
      const sessionId = sessionIds.find((candidate) => String(opts.cwd).includes(candidate));
      const prompt = mock(async () => {
        if (!sessionId) throw new Error("missing worker session id");
        updateManifest(paths, cwd, sessionId, (manifest) => {
          manifest.state = "blocked";
          manifest.blocker = {
            code: "proof-missing",
            message: `Need more proof for ${sessionId}` ,
            scope: "scenario",
            affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "scenario-a" },
            recoverable: true,
            recoveryMode: "retry",
            nextAction: "Rerun the proof",
            retryable: true,
            detectedAt: "2026-04-19T12:05:00.000Z",
          };
        });
      });
      return { prompt, dispose: mock(async () => {}), subscribe: () => () => {}, state: { messages: [] } };
    });
    const platform = {
      paths,
      exec: createBatchExecMock(cwd),
      createAgentSession,
    } as any;
    const ctx = createUltraplanCtx({
      hasUI: true,
      selectResponses: ["Batch sessions", "Start batch"],
      inputResponses: [sessionIds.join(","), "2"],
    });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    const batchRunsDir = path.dirname(getUltraplanBatchRunPath(paths, cwd, "placeholder")).replace(/placeholder$/, "");
    const entries = fs.readdirSync(batchRunsDir).filter((entry) => entry !== "active-run.json");
    expect(entries.length).toBe(1);
    const savedRun = JSON.parse(fs.readFileSync(getUltraplanBatchRunPath(paths, cwd, entries[0]!), "utf8"));
    expect(platform.createAgentSession).toHaveBeenCalledTimes(2);
    expect(savedRun.maxParallelism).toBe(2);
    expect(savedRun.baseBranch).toBe("main");
    expect(savedRun.baseHead).toBe("sha-head");
    expect(savedRun.currentBaseHead).toBe("sha-head");
    expect(savedRun.supervisorWorktreePath).toBe(cwd);
    expect(savedRun.nodes.map((node: any) => node.title)).toEqual(["Batch Alpha", "Batch Beta"]);
    expect(savedRun.state).toBe("paused");
    const infos = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "info");
    const lastInfo = infos[infos.length - 1] as unknown[] | undefined;
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan batch paused");
  });

  test("run blocks the affected node when worker launch fails after worktree preparation", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-batch-launch-fails";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    updateManifest(paths, cwd, sessionId, (manifest) => {
      manifest.title = "Batch Launch Failure";
      manifest.state = "ready";
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId, title: "Batch Launch Failure", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:00:00.000Z", cursor: null, idleReason: null },
      ],
    });
    const platform = {
      paths,
      exec: createBatchExecMock(cwd),
      createAgentSession: mock(async () => { throw new Error("agent session launch failed"); }),
    } as any;
    const ctx = createUltraplanCtx({
      hasUI: true,
      selectResponses: ["Start batch"],
      inputResponses: [sessionId, "1"],
    });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run batch");

    const batchRunsDir = path.dirname(getUltraplanBatchRunPath(paths, cwd, "placeholder")).replace(/placeholder$/, "");
    const entries = fs.readdirSync(batchRunsDir).filter((entry) => entry !== "active-run.json");
    expect(entries.length).toBe(1);
    const savedRun = JSON.parse(fs.readFileSync(getUltraplanBatchRunPath(paths, cwd, entries[0]!), "utf8"));
    const node = savedRun.nodes[0];
    expect(node.state).toBe("blocked");
    expect(node.blockerKind).toBe("supervisor");
    expect(node.blockerSummary).toContain("agent session launch failed");
    expect(node.branchName).toContain(sessionId);
    expect(node.worktreePath).toContain(sessionId);
  });

  test("run resumes an active batch through the supervisor instead of only rendering a summary", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-batch-resume";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    updateManifest(paths, cwd, sessionId, (manifest) => { manifest.title = "Batch Resume"; manifest.state = "ready"; });
    const run = makeUltraPlanBatchRun({
      runId: "batch-active",
      projectRoot: cwd,
      baseBranch: "main",
      baseHead: "sha-head",
      currentBaseHead: "sha-head",
      supervisorWorktreePath: cwd,
      state: "paused",
      nodes: [makeUltraPlanBatchNode({ nodeId: "node-1", sessionId, title: "Batch Resume", waveIndex: 0 })],
      waves: [{ waveIndex: 0, sessionIds: [sessionId] }],
    });
    const activeRunPath = getUltraplanActiveBatchRunPath(paths, cwd);
    const runPath = getUltraplanBatchRunPath(paths, cwd, run.runId);
    fs.mkdirSync(path.dirname(activeRunPath), { recursive: true });
    fs.mkdirSync(path.dirname(runPath), { recursive: true });
    fs.writeFileSync(activeRunPath, `${JSON.stringify(makeUltraPlanBatchActiveRunLease({ runId: run.runId, ownerSessionId: null, leaseAcquiredAt: null, leaseExpiresAt: null, updatedAt: run.updatedAt }), null, 2)}\n`);
    fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);

    const createAgentSession = mock(async (opts: any) => ({
      prompt: mock(async () => {
        expect(String(opts.cwd)).toContain(sessionId);
        updateManifest(paths, cwd, sessionId, (manifest) => {
          manifest.state = "blocked";
          manifest.blocker = {
            code: "proof-missing",
            message: "Need resume proof",
            scope: "scenario",
            affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "scenario-a" },
            recoverable: true,
            recoveryMode: "retry",
            nextAction: "Rerun the proof",
            retryable: true,
            detectedAt: "2026-04-19T12:05:00.000Z",
          };
        });
      }),
      dispose: mock(async () => {}),
      subscribe: () => () => {},
      state: { messages: [] },
    }));
    const platform = {
      paths,
      exec: createBatchExecMock(cwd),
      createAgentSession,
    } as any;
    const ctx = createUltraplanCtx({ hasUI: true });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(platform.createAgentSession).toHaveBeenCalledTimes(1);
    const savedRun = JSON.parse(fs.readFileSync(runPath, "utf8"));
    expect(savedRun.state).toBe("paused");
    const infos = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "info");
    const lastInfo = infos[infos.length - 1] as unknown[] | undefined;
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan batch paused");
  });

  test("run fails closed when an active batch lease is still live under another owner", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const run = makeUltraPlanBatchRun({
      runId: "batch-busy",
      projectRoot: cwd,
      baseBranch: "main",
      baseHead: "sha-head",
      currentBaseHead: "sha-head",
      supervisorWorktreePath: cwd,
      state: "paused",
    });
    const activeRunPath = getUltraplanActiveBatchRunPath(paths, cwd);
    const runPath = getUltraplanBatchRunPath(paths, cwd, run.runId);
    fs.mkdirSync(path.dirname(activeRunPath), { recursive: true });
    fs.mkdirSync(path.dirname(runPath), { recursive: true });
    fs.writeFileSync(
      activeRunPath,
      `${JSON.stringify(makeUltraPlanBatchActiveRunLease({
        runId: run.runId,
        ownerSessionId: "main-session-2",
        leaseAcquiredAt: "2026-04-21T12:00:00.000Z",
        leaseExpiresAt: "2099-04-21T12:05:00.000Z",
        updatedAt: "2026-04-21T12:00:00.000Z",
      }), null, 2)}\n`,
    );
    fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);

    const platform = {
      paths,
      createAgentSession: mock(async () => { throw new Error("should not dispatch while another supervisor owns the lease"); }),
    } as any;
    const ctx = createUltraplanCtx({ hasUI: true });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "run");

    expect(platform.createAgentSession).not.toHaveBeenCalled();
    const errors = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "error");
    const lastError = errors[errors.length - 1] as unknown[] | undefined;
    expect(String(lastError?.[0] ?? "")).toContain("invalid-run");
    expect(String(lastError?.[0] ?? "")).toContain("already supervised by main-session-2");
  });

  test("batch resume surfaces blocked summaries and only unblocks after batchResumeRequestedAt is stamped", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const run = makeUltraPlanBatchRun({
      runId: "batch-blocked",
      state: "blocked",
      batchBlockerCode: "base-drift",
      batchBlockerSummary: "Supervisor branch advanced before merge.",
      nodes: [makeUltraPlanBatchRun().nodes[0]!],
      waves: [makeUltraPlanBatchRun().waves[0]!],
    });
    const activeRunPath = getUltraplanActiveBatchRunPath(paths, cwd);
    const runPath = getUltraplanBatchRunPath(paths, cwd, run.runId);
    fs.mkdirSync(path.dirname(activeRunPath), { recursive: true });
    fs.mkdirSync(path.dirname(runPath), { recursive: true });
    fs.writeFileSync(activeRunPath, `${JSON.stringify(makeUltraPlanBatchActiveRunLease({ runId: run.runId }), null, 2)}\n`);
    fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);

    const summary = renderUltraPlanBatchStatusForTesting({ paths, cwd });
    expect(summary).toContain("Batch blocked: base-drift");
    expect(summary).toContain("Supervisor branch advanced before merge.");

    const stillBlocked = resumeUltraPlanBatchRunForTesting({ paths, cwd });
    expect(stillBlocked.state).toBe("blocked");
    expect(stillBlocked.batchResumeRequestedAt).toBeNull();

    const resumed = resumeUltraPlanBatchRunForTesting({
      paths,
      cwd,
      batchResumeRequestedAt: "2026-04-21T13:00:00.000Z",
    });
    expect(resumed.batchResumeRequestedAt).toBe("2026-04-21T13:00:00.000Z");
  });

  test("stamps node retry fields and renders resume surfaces for running workers, kept worktrees, and later-wave eligibility", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const run = makeUltraPlanBatchRun({
      runId: "batch-resume",
      state: "running",
      nodes: [
        makeUltraPlanBatchNode({ nodeId: "node-running", sessionId: "up-running", waveIndex: 0, state: "running", worktreePath: "/repo/.worktrees/batch-running" }),
        makeUltraPlanBatchNode({ nodeId: "node-blocked", sessionId: "up-blocked", waveIndex: 1, state: "blocked", blockerKind: "dependency", blockerSummary: "waiting", dependencies: ["up-running"] }),
        makeUltraPlanBatchNode({ nodeId: "node-later", sessionId: "up-later", waveIndex: 2, dependencies: ["up-blocked"], worktreePath: "/repo/.worktrees/batch-later" }),
      ],
      waves: [
        { waveIndex: 0, sessionIds: ["up-running"] },
        { waveIndex: 1, sessionIds: ["up-blocked"] },
        { waveIndex: 2, sessionIds: ["up-later"] },
      ],
    });
    const activeRunPath = getUltraplanActiveBatchRunPath(paths, cwd);
    const runPath = getUltraplanBatchRunPath(paths, cwd, run.runId);
    fs.mkdirSync(path.dirname(activeRunPath), { recursive: true });
    fs.mkdirSync(path.dirname(runPath), { recursive: true });
    fs.writeFileSync(activeRunPath, `${JSON.stringify(makeUltraPlanBatchActiveRunLease({ runId: run.runId }), null, 2)}\n`);
    fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);

    const retried = resumeUltraPlanBatchRunForTesting({
      paths,
      cwd,
      retrySessionId: "up-blocked",
      resumeRequestedAt: "2026-04-21T13:05:00.000Z",
    });
    expect(retried.nodes.find((node) => node.sessionId === "up-blocked")?.resumeRequestedAt).toBe("2026-04-21T13:05:00.000Z");

    const summary = renderUltraPlanBatchStatusForTesting({ paths, cwd });
    expect(summary).toContain("Running workers: up-running");
    expect(summary).toContain("Kept worktrees: /repo/.worktrees/batch-running, /repo/.worktrees/batch-later");
    expect(summary).toContain("Later wave queued: up-later becomes eligible after up-blocked merges.");
  });

  test("refuses batch or node abandonment while work is in flight and allows it once stable", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const inFlight = makeUltraPlanBatchRun({
      runId: "batch-in-flight",
      state: "running",
      nodes: [makeUltraPlanBatchNode({ nodeId: "node-running", sessionId: "up-running", waveIndex: 0, state: "running" })],
      waves: [{ waveIndex: 0, sessionIds: ["up-running"] }],
    });
    const stable = makeUltraPlanBatchRun({
      runId: "batch-stable",
      state: "paused",
      nodes: [makeUltraPlanBatchNode({ nodeId: "node-paused", sessionId: "up-paused", waveIndex: 0, state: "blocked", blockerKind: "session", blockerSummary: "waiting" })],
      waves: [{ waveIndex: 0, sessionIds: ["up-paused"] }],
    });

    const inFlightRunPath = getUltraplanBatchRunPath(paths, cwd, inFlight.runId);
    const stableRunPath = getUltraplanBatchRunPath(paths, cwd, stable.runId);
    fs.mkdirSync(path.dirname(inFlightRunPath), { recursive: true });
    fs.mkdirSync(path.dirname(stableRunPath), { recursive: true });
    fs.writeFileSync(inFlightRunPath, `${JSON.stringify(inFlight, null, 2)}\n`);
    fs.writeFileSync(stableRunPath, `${JSON.stringify(stable, null, 2)}\n`);

    expect(() => abandonUltraPlanBatchForTesting({ paths, cwd, runId: inFlight.runId })).toThrow(/in flight/i);
    expect(() => abandonUltraPlanBatchNodeForTesting({ paths, cwd, runId: inFlight.runId, sessionId: "up-running" })).toThrow(/in flight/i);

    const abandonedRun = abandonUltraPlanBatchForTesting({ paths, cwd, runId: stable.runId });
    expect(abandonedRun.state).toBe("abandoned");
    const abandonedNodeRun = abandonUltraPlanBatchNodeForTesting({ paths, cwd, runId: stable.runId, sessionId: "up-paused" });
    expect(abandonedNodeRun.nodes[0]?.state).toBe("abandoned");
  });
  test("status orders incomplete sessions before done sessions and sorts the done block by title then sessionId", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionIds = {
      doneBravo: "up-status-done-c",
      awaiting: "up-status-awaiting",
      doneAlphaB: "up-status-done-b",
      pending: "up-status-pending",
      ongoing: "up-status-ongoing",
      doneAlphaA: "up-status-done-a",
    } as const;

    for (const sessionId of Object.values(sessionIds)) {
      seedCanonicalGlobalSession(paths, cwd, sessionId);
    }

    updateManifest(paths, cwd, sessionIds.awaiting, (manifest) => {
      manifest.title = "Awaiting session";
      manifest.state = "awaiting-user";
      manifest.blocker = {
        code: "blocked",
        message: "Need product sign-off",
        scope: "session",
        affected: { stack: null, domainId: null, level: null, scenarioId: null },
        recoverable: false,
        recoveryMode: "await-user",
        nextAction: "Wait for sign-off",
        retryable: false,
        detectedAt: "2026-04-19T12:05:00.000Z",
      };
    });
    updateManifest(paths, cwd, sessionIds.pending, (manifest) => {
      manifest.title = "Pending session";
      manifest.state = "ready";
    });
    updateManifest(paths, cwd, sessionIds.ongoing, (manifest) => {
      manifest.title = "Ongoing session";
      manifest.state = "running";
    });
    updateManifest(paths, cwd, sessionIds.doneAlphaA, (manifest) => {
      manifest.title = "Alpha done";
      manifest.state = "discarded";
    });
    updateManifest(paths, cwd, sessionIds.doneAlphaB, (manifest) => {
      manifest.title = "Alpha done";
      manifest.state = "discarded";
    });
    updateManifest(paths, cwd, sessionIds.doneBravo, (manifest) => {
      manifest.title = "Bravo done";
      manifest.state = "discarded";
    });
    updateAuthored(paths, cwd, sessionIds.doneAlphaA, (authored) => {
      authored.stacks[0].domains[0].unit[0].title = "Zulu current";
    });
    updateAuthored(paths, cwd, sessionIds.doneAlphaB, (authored) => {
      authored.stacks[0].domains[0].unit[0].title = "Alpha current";
    });

    seedGlobalIndex(paths, cwd, {
      sessions: [
        { sessionId: sessionIds.doneBravo, title: "Bravo done", state: "discarded", bucket: "done", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
        { sessionId: sessionIds.awaiting, title: "Awaiting session", state: "awaiting-user", bucket: "idle", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: "Need product sign-off" },
        { sessionId: sessionIds.doneAlphaB, title: "Alpha done", state: "discarded", bucket: "done", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
        { sessionId: sessionIds.pending, title: "Pending session", state: "ready", bucket: "pending", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
        { sessionId: sessionIds.ongoing, title: "Ongoing session", state: "running", bucket: "ongoing", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
        { sessionId: sessionIds.doneAlphaA, title: "Alpha done", state: "discarded", bucket: "done", createdAt: "2026-04-19T12:00:00.000Z", updatedAt: "2026-04-19T12:05:00.000Z", cursor: null, idleReason: null },
      ],
    });

    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: true });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "status");

    const options = ctx.select.mock.calls[0]?.[1] as string[] | undefined;
    expect(pickerLabels(ctx)).toEqual([
      "[ongoing] Ongoing session",
      "[pending] Pending session",
      "[idle] Awaiting session",
      "[done] Alpha done",
      "[done] Alpha done",
      "[done] Bravo done",
    ]);
    expect(options?.slice(3)).toEqual([
      "[done] Alpha done — Current: frontend / auth / unit / Zulu current",
      "[done] Alpha done — Current: frontend / auth / unit / Alpha current",
      "[done] Bravo done — Current: frontend / auth / unit / First scenario",
    ]);
  });
  test("status still renders the inspect-style status output", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-status";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    seedGlobalIndex(paths, cwd, {
      sessions: [{
        sessionId,
        title: "Status session",
        state: "ready",
        bucket: "pending",
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        cursor: null,
        idleReason: null,
      }],
    });

    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: true, pickFirstSelect: true });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, "status");

    const infos = ctx.notify.mock.calls.filter((call: unknown[]) => call[1] === "info");
    const lastInfo = infos[infos.length - 1] as unknown[] | undefined;
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan status");
    expect(String(lastInfo?.[0] ?? "")).toContain("State: ready");
  });
});

describe("handleUltraplan end-to-end integration", () => {
  test("authoring is delegated to the active agent instead of persisting synchronously", async () => {
    const { loadUltraPlanIndex } = await import("../../src/ultraplan/storage.js");
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sendMessage = mock(() => {});
    const platform = { paths, sendMessage } as any;
    const ctx = createUltraplanCtx({ hasUI: true, inputResponses: ["test", "a session"] });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, undefined);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.input).not.toHaveBeenCalled();
    const indexResult = loadUltraPlanIndex(paths, cwd);
    expect(indexResult.ok).toBe(false);

    const infos = (ctx.notify.mock.calls as unknown[][]).filter((call: unknown[]) => call[1] === "info");
    expect(String(infos[0]?.[0] ?? "")).toContain("UltraPlan authoring started");
  });
});