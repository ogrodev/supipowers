import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UltraPlanIndex } from "../../src/types.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanIndexPath,
  getUltraplanManifestPath,
  getUltraplanMigrationRecordPath,
  getUltraplanSessionDir,
} from "../../src/ultraplan/project-paths.js";
import { loadVisibleSessionsForTesting } from "../../src/commands/ultraplan.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
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

function writeGlobalConfig(paths: ReturnType<typeof createTestPaths>, data: unknown): void {
  const configPath = paths.global("config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`);
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
  inputResponses?: Array<string | null>;
  pickFirstSelect?: boolean;
} = {}) {
  const selectResponses = overrides.selectResponses ?? [];
  const inputResponses = overrides.inputResponses ?? [];
  let sIdx = 0;
  let iIdx = 0;
  const select = mock(async (_title?: string, options?: string[]) => {
    const explicit = selectResponses[sIdx] ?? null;
    sIdx += 1;
    if (explicit !== null) {
      return explicit;
    }
    if (overrides.pickFirstSelect && Array.isArray(options) && options.length > 0) {
      return options[0];
    }
    return null;
  });
  const input = mock(async () => {
    const v = inputResponses[iIdx] ?? null;
    iIdx += 1;
    return v;
  });
  const notify = mock(() => {});
  const confirm = mock(async () => true);

  return {
    cwd: "",
    hasUI: overrides.hasUI ?? true,
    ui: { select, input, notify, confirm },
    select, input, notify, confirm,
  };
}

describe("handleUltraplan bare-call", () => {
  test("hasUI:true + undefined args routes to runUltraPlanAuthoringWizard (input prompted)", async () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: true, inputResponses: [null] });
    ctx.cwd = cwd;
    await handleUltraplan(platform, ctx, undefined);
    // Wizard was engaged: the input prompt fired.
    expect(ctx.input).toHaveBeenCalled();
  });

  test("hasUI:false + undefined args emits a warning notify", async () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: false });
    ctx.cwd = cwd;
    await handleUltraplan(platform, ctx, undefined);
    const warnings = ctx.notify.mock.calls.filter((c: unknown[]) => c[1] === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("catalog preflight failures surface an error notify instead of failing silently", async () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    writeGlobalConfig(paths, {
      ultraplan: {
        slots: {
          "backend-tester": {
            agentName: "integration-breaker",
          },
        },
      },
    });
    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: true });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, undefined);

    const errors: unknown[][] = ctx.notify.mock.calls.filter((c: unknown[]) => c[1] === "error");
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain("Ultraplan authoring cannot start");
    expect(String(errors[0][0])).toContain("Only repository config may define ultraplan");
    expect(ctx.input).not.toHaveBeenCalled();
  });

  test("empty-string args routes identically to undefined", async () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: true, inputResponses: [null] });
    ctx.cwd = cwd;
    await handleUltraplan(platform, ctx, "");
    expect(ctx.input).toHaveBeenCalled();
  });
});

describe("handleUltraplan regressions", () => {
  test("/supi:ultraplan next still emits the deferred stub notify", async () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const platform = { paths } as any;
    const ctx = createUltraplanCtx({ hasUI: true });
    ctx.cwd = cwd;
    await handleUltraplan(platform, ctx, "next");
    const nextNotifies = ctx.notify.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("next is not implemented in this phase"),
    );
    expect(nextNotifies.length).toBe(1);
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
      { value: "run ", label: "run", description: "Inspect an existing ultraplan session" },
      { value: "status ", label: "status", description: "Show status for an ultraplan session" },
      { value: "next ", label: "next", description: "Deferred to a later ultraplan phase" },
    ]);
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

  test("pre-run paused sessions render the concise paused output without dispatching", async () => {
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
    expect(String(lastInfo?.[0] ?? "")).toContain("Ultraplan paused");
    expect(String(lastInfo?.[0] ?? "")).toContain("Need the failing proof before resume");
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
  test("author a minimal session via handleUltraplan → manifest + index reflect the new session", async () => {
    const { loadUltraPlanIndex, loadUltraPlanManifest } = await import("../../src/ultraplan/storage.js");
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const platform = { paths } as any;
    const ctx = createUltraplanCtx({
      hasUI: true,
      inputResponses: ["test", "a session", "auth", "login"],
      selectResponses: [
        "applicable", "not-applicable", "not-applicable",
        "+ Add domain", "✓ Done with frontend domains",
        "+ Add unit scenario", "✓ Done with unit",
        "✓ Done with integration", "✓ Done with e2e",
        "✓ Approve & save",
      ],
    });
    ctx.cwd = cwd;

    await handleUltraplan(platform, ctx, undefined);

    const indexResult = loadUltraPlanIndex(paths, cwd);
    expect(indexResult.ok).toBe(true);
    if (!indexResult.ok) return;
    expect(indexResult.value.sessions).toHaveLength(1);
    const sessionId = indexResult.value.sessions[0].sessionId;

    expect(fs.existsSync(getUltraplanAuthoredJsonPath(paths, cwd, sessionId))).toBe(true);
    expect(fs.existsSync(getUltraplanManifestPath(paths, cwd, sessionId))).toBe(true);
    expect(fs.existsSync(getUltraplanIndexPath(paths, cwd))).toBe(true);

    const manifestResult = loadUltraPlanManifest(paths, cwd, sessionId);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    expect(manifestResult.value.state).toBe("ready");
    expect(manifestResult.value.cursor?.targetType).toBe("scenario");
    expect(manifestResult.value.cursor?.phase).toBe("red");
    expect(manifestResult.value.cursor?.status).toBe("planned");

    const successNotifies: unknown[][] = ctx.notify.mock.calls.filter((c: unknown[]) =>
      String(c[0]).toLowerCase().includes("saved"),
    );
    expect(successNotifies.length).toBe(1);
    expect(String(successNotifies[0][0])).toContain("test");
  });
});