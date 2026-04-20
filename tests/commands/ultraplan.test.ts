import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Platform } from "../../src/platform/types.js";
import type { UltraPlanAuthoredArtifact, UltraPlanIndex, UltraPlanManifest } from "../../src/types.js";
import { bootstrap } from "../../src/bootstrap.js";
import { registerUltraplanCommand } from "../../src/commands/ultraplan.js";
import { getUltraplanAuthoredJsonPath } from "../../src/ultraplan/project-paths.js";
import { saveUltraPlanAuthoredArtifact, saveUltraPlanIndex, saveUltraPlanManifest } from "../../src/ultraplan/storage.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanManifest,
  makeUltraPlanScenario,
  makeUltraPlanStack,
} from "../ultraplan/fixtures.js";

let tmpDir: string;

function createPlatform(rootDir: string): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: createTestPaths(rootDir),
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
  } as unknown as Platform;
}

function createRepoRoot(name = "supipowers"): string {
  return createTestRepo(tmpDir, name).repoRoot;
}

function makeCompleteAuthored(sessionId: string, title: string): UltraPlanAuthoredArtifact {
  const authored = makeAuthored(sessionId, title);
  const domain = authored.stacks[0].domains[0];
  domain.unit[1] = {
    ...domain.unit[1],
    status: "done",
    proofs: [{
      type: "artifact",
      phase: "complete",
      recordedAt: "2026-04-19T12:20:00.000Z",
      actor: "frontend-executor",
      evidence: { summary: "complete proof" },
      artifactRef: "artifact://complete-proof-2",
    }],
  };
  domain.review = { enabled: false, status: "pending" };
  domain.progress = { total: 2, terminal: 2, blocked: 0 };
  authored.stacks[0].agentSlots = {
    ...authored.stacks[0].agentSlots,
    domainReviewEnabled: false,
    stackReviewEnabled: false,
    domainReviewer: undefined,
    stackReviewer: undefined,
  };
  authored.stacks[0].progress = { total: 2, terminal: 2, blocked: 0 };
  return authored;
}

function makeAuthored(sessionId: string, title: string): UltraPlanAuthoredArtifact {
  return makeUltraPlanAuthored({
    sessionId,
    title,
    goal: `Ship ${title}`,
    stacks: [makeUltraPlanStack({
      domains: [
        {
          id: "auth",
          name: "Authentication",
          unit: [
            makeUltraPlanScenario("scenario-a", "First scenario", "done"),
            makeUltraPlanScenario("scenario-b", "Second scenario", "planned"),
          ],
          integration: [],
          e2e: [],
          review: {
            enabled: true,
            status: "pending",
          },
          progress: {
            total: 2,
            terminal: 1,
            blocked: 0,
          },
        },
      ],
      progress: {
        total: 2,
        terminal: 1,
        blocked: 0,
      },
    })],
  });
}

function makeManifest(sessionId: string, title: string, state: UltraPlanManifest["state"]): UltraPlanManifest {
  return makeUltraPlanManifest({
    sessionId,
    title,
    state,
    cursor: {
      targetType: "scenario",
      stack: "frontend",
      domainId: "auth",
      level: "unit",
      scenarioId: "scenario-a",
      phase: "complete",
      status: "done",
      summary: "stale summary",
    },
    lastCompleted: {
      targetType: "scenario",
      stack: "frontend",
      domainId: "auth",
      level: "unit",
      scenarioId: "scenario-a",
      phase: "complete",
      status: "done",
      summary: "frontend / auth / unit / First scenario",
    },
    progress: {
      total: 2,
      terminal: 1,
      blocked: state === "blocked" || state === "awaiting-user" ? 1 : 0,
    },
    stacks: [
      {
        stack: "frontend",
        applicability: "applicable",
        progress: {
          total: 1,
          terminal: 0,
          blocked: state === "blocked" || state === "awaiting-user" ? 1 : 0,
        },
        domainCount: 1,
        terminalDomainCount: 0,
      },
    ],
    blocker: state === "awaiting-user"
      ? {
          code: "awaiting-input",
          message: "Need product sign-off",
          scope: "session",
          affected: {
            stack: null,
            domainId: null,
            level: null,
            scenarioId: null,
          },
          recoverable: true,
          recoveryMode: "await-user",
          nextAction: "Wait for user input",
          retryable: false,
          detectedAt: "2026-04-19T12:16:00.000Z",
        }
      : null,
  });
}

function seedSession(platform: Platform, cwd: string, manifest: UltraPlanManifest, authored: UltraPlanAuthoredArtifact): void {
  const manifestResult = saveUltraPlanManifest(platform.paths, cwd, manifest.sessionId, manifest);
  expect(manifestResult.ok).toBe(true);
  const authoredResult = saveUltraPlanAuthoredArtifact(platform.paths, cwd, authored.sessionId, authored);
  expect(authoredResult.ok).toBe(true);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-cmd-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ultraplan command", () => {
  test("registers the command from bootstrap and exposes subcommand completions", () => {
    const platform = createPlatform(tmpDir);
    bootstrap(platform);
    expect((platform.registerCommand as any).mock.calls.some((call: any[]) => call[0] === "supi:ultraplan")).toBe(true);

    const directPlatform = createPlatform(tmpDir);
    registerUltraplanCommand(directPlatform);
    const command = (directPlatform.registerCommand as any).mock.calls[0][1];
    expect(command.getArgumentCompletions("")).toEqual([
      { value: "run ", label: "run", description: "Inspect an existing ultraplan session" },
      { value: "status ", label: "status", description: "Show status for an ultraplan session" },
      { value: "next ", label: "next", description: "Deferred to a later ultraplan phase" },
    ]);
  });

  test("run picker keeps stale complete sessions visible and filters truly complete sessions", async () => {
    const platform = createPlatform(tmpDir);
    const cwd = createRepoRoot();
    const pendingManifest = makeManifest("up-pending", "Pending session", "ready");
    const ongoingManifest = makeManifest("up-ongoing", "Ongoing session", "running");
    const idleManifest = makeManifest("up-idle", "Idle session", "awaiting-user");
    const staleCompleteManifest = {
      ...makeManifest("up-stale", "Stale complete session", "complete"),
      blocker: null,
    } satisfies UltraPlanManifest;
    const completeManifest = {
      ...makeManifest("up-complete", "Actually complete session", "complete"),
      blocker: null,
    } satisfies UltraPlanManifest;

    seedSession(platform, cwd, pendingManifest, makeAuthored("up-pending", "Pending session"));
    seedSession(platform, cwd, ongoingManifest, makeAuthored("up-ongoing", "Ongoing session"));
    seedSession(platform, cwd, idleManifest, makeAuthored("up-idle", "Idle session"));
    seedSession(platform, cwd, staleCompleteManifest, makeAuthored("up-stale", "Stale complete session"));
    seedSession(platform, cwd, completeManifest, makeCompleteAuthored("up-complete", "Actually complete session"));

    const index = {
      sessions: [
        { sessionId: "up-pending", title: "Pending session", state: "ready", bucket: "pending", createdAt: pendingManifest.createdAt, updatedAt: pendingManifest.updatedAt, cursor: pendingManifest.cursor, idleReason: null },
        { sessionId: "up-ongoing", title: "Ongoing session", state: "running", bucket: "ongoing", createdAt: ongoingManifest.createdAt, updatedAt: ongoingManifest.updatedAt, cursor: ongoingManifest.cursor, idleReason: null },
        { sessionId: "up-idle", title: "Idle session", state: "awaiting-user", bucket: "idle", createdAt: idleManifest.createdAt, updatedAt: idleManifest.updatedAt, cursor: idleManifest.cursor, idleReason: "Need product sign-off" },
        { sessionId: "up-stale", title: "Stale complete session", state: "complete", bucket: "done", createdAt: staleCompleteManifest.createdAt, updatedAt: staleCompleteManifest.updatedAt, cursor: staleCompleteManifest.cursor, idleReason: null },
        { sessionId: "up-complete", title: "Actually complete session", state: "complete", bucket: "done", createdAt: completeManifest.createdAt, updatedAt: completeManifest.updatedAt, cursor: completeManifest.cursor, idleReason: null },
      ],
    } satisfies UltraPlanIndex;
    expect(saveUltraPlanIndex(platform.paths, cwd, index).ok).toBe(true);

    const select = mock(async (_title: string, options: string[]) => {
      expect(options.some((option) => option.startsWith("[pending] Pending session"))).toBe(true);
      expect(options.some((option) => option.startsWith("[ongoing] Ongoing session"))).toBe(true);
      expect(options.some((option) => option.startsWith("[idle] Idle session"))).toBe(true);
      expect(options.some((option) => option.includes("Stale complete session"))).toBe(true);
      expect(options.some((option) => option.includes("Actually complete session"))).toBe(false);
      return options.find((option) => option.includes("Stale complete session")) ?? null;
    });

    registerUltraplanCommand(platform);
    const handler = (platform.registerCommand as any).mock.calls[0][1].handler;
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        notify: mock(),
        select,
        input: mock(),
        setStatus: mock(),
      },
    } as any;

    await handler("run", ctx);

    const output = ctx.ui.notify.mock.calls.map((call: any[]) => call[0]).join("\n");
    expect(output).toContain("Current: frontend / auth / unit / Second scenario");
    expect(output).toContain("Current source: recomputed");
    expect(output).toContain("Domain progress: auth 1/2 scenarios terminal");
  });

  test("status renders the selected session summary including blocker details", async () => {
    const platform = createPlatform(tmpDir);
    const cwd = createRepoRoot();
    const manifest = makeManifest("up-idle", "Idle session", "awaiting-user");
    const authored = makeAuthored("up-idle", "Idle session");
    seedSession(platform, cwd, manifest, authored);
    expect(saveUltraPlanIndex(platform.paths, cwd, {
      sessions: [
        { sessionId: manifest.sessionId, title: manifest.title, state: manifest.state, bucket: "idle", createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, cursor: manifest.cursor, idleReason: "Need product sign-off" },
      ],
    } satisfies UltraPlanIndex).ok).toBe(true);

    registerUltraplanCommand(platform);
    const handler = (platform.registerCommand as any).mock.calls[0][1].handler;
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        notify: mock(),
        select: mock(async (_title: string, options: string[]) => options[0]),
        input: mock(),
        setStatus: mock(),
      },
    } as any;

    await handler("status", ctx);

    const output = ctx.ui.notify.mock.calls.map((call: any[]) => call[0]).join("\n");
    expect(output).toContain("Title: Idle session");
    expect(output).toContain("Bucket: idle");
    expect(output).toContain("Last completed (persisted): frontend / auth / unit / First scenario");
    expect(output).toContain("Stack progress (persisted): frontend 0/1 domains terminal");
    expect(output).toContain("Idle reason: Awaiting user: Need product sign-off");
  });

  test("status can inspect completed sessions", async () => {
    const platform = createPlatform(tmpDir);
    const cwd = createRepoRoot();
    const manifest = {
      ...makeManifest("up-complete", "Completed session", "complete"),
      blocker: null,
    } satisfies UltraPlanManifest;
    const authored = makeCompleteAuthored("up-complete", "Completed session");

    seedSession(platform, cwd, manifest, authored);
    expect(saveUltraPlanIndex(platform.paths, cwd, {
      sessions: [
        {
          sessionId: manifest.sessionId,
          title: manifest.title,
          state: manifest.state,
          bucket: "done",
          createdAt: manifest.createdAt,
          updatedAt: manifest.updatedAt,
          cursor: manifest.cursor,
          idleReason: null,
        },
      ],
    } satisfies UltraPlanIndex).ok).toBe(true);

    registerUltraplanCommand(platform);
    const handler = (platform.registerCommand as any).mock.calls[0][1].handler;
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        notify: mock(),
        select: mock(async (_title: string, options: string[]) => options[0]),
        input: mock(),
        setStatus: mock(),
      },
    } as any;

    await handler("status", ctx);

    const output = ctx.ui.notify.mock.calls.map((call: any[]) => call[0]).join("\n");
    expect(output).toContain("Title: Completed session");
    expect(output).toContain("Bucket: done");
    expect(output).toContain("Next action: None — session complete");
  });

  test("warns when the ultraplan index is missing instead of claiming there are no sessions", async () => {
    const platform = createPlatform(tmpDir);
    const cwd = createRepoRoot();

    registerUltraplanCommand(platform);
    const handler = (platform.registerCommand as any).mock.calls[0][1].handler;
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        notify: mock(),
        select: mock(),
        input: mock(),
        setStatus: mock(),
      },
    } as any;

    await handler("run", ctx);

    const output = ctx.ui.notify.mock.calls.map((call: any[]) => call[0]).join("\n");
    expect(output).toContain("Ultraplan session index is missing");
    expect(output).not.toContain("No incomplete ultraplan sessions");
  });


  test("skips invalid indexed sessions while keeping valid sessions selectable", async () => {
    const platform = createPlatform(tmpDir);
    const cwd = createRepoRoot();
    const validManifest = makeManifest("up-valid", "Valid session", "ready");
    const validAuthored = makeAuthored("up-valid", "Valid session");
    const brokenManifest = makeManifest("up-broken", "Broken session", "ready");
    const brokenAuthored = makeAuthored("up-broken", "Broken session");

    seedSession(platform, cwd, validManifest, validAuthored);
    seedSession(platform, cwd, brokenManifest, brokenAuthored);
    fs.writeFileSync(
      getUltraplanAuthoredJsonPath(platform.paths, cwd, brokenManifest.sessionId),
      JSON.stringify({ sessionId: brokenAuthored.sessionId, title: brokenAuthored.title }),
      "utf8",
    );
    expect(saveUltraPlanIndex(platform.paths, cwd, {
      sessions: [
        {
          sessionId: validManifest.sessionId,
          title: validManifest.title,
          state: validManifest.state,
          bucket: "pending",
          createdAt: validManifest.createdAt,
          updatedAt: validManifest.updatedAt,
          cursor: validManifest.cursor,
          idleReason: null,
        },
        {
          sessionId: brokenManifest.sessionId,
          title: brokenManifest.title,
          state: brokenManifest.state,
          bucket: "pending",
          createdAt: brokenManifest.createdAt,
          updatedAt: brokenManifest.updatedAt,
          cursor: brokenManifest.cursor,
          idleReason: null,
        },
      ],
    } satisfies UltraPlanIndex).ok).toBe(true);

    registerUltraplanCommand(platform);
    const handler = (platform.registerCommand as any).mock.calls[0][1].handler;
    const select = mock(async (_title: string, options: string[]) => options[0] ?? null);
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        notify: mock(),
        select,
        input: mock(),
        setStatus: mock(),
      },
    } as any;

    await handler("run", ctx);

    const output = ctx.ui.notify.mock.calls.map((call: any[]) => call[0]).join("\n");
    expect(select).toHaveBeenCalled();
    expect(output).toContain("Skipped invalid ultraplan sessions");
    expect(output).toContain("up-broken");
    expect(output).toContain("Artifact failed schema validation");
    expect(output).toContain("/goal");
    expect(output).toContain("Current: frontend / auth / unit / Second scenario");
  });


  test("reports deferred scope for bare command and next, and errors on unknown subcommands", async () => {
    const platform = createPlatform(tmpDir);
    registerUltraplanCommand(platform);
    const handler = (platform.registerCommand as any).mock.calls[0][1].handler;
    const ctx = {
      cwd: createRepoRoot(),
      hasUI: true,
      ui: {
        notify: mock(),
        select: mock(),
        input: mock(),
        setStatus: mock(),
      },
    } as any;

    await handler(undefined, ctx);
    await handler("next", ctx);
    await handler("mystery", ctx);

    const output = ctx.ui.notify.mock.calls.map((call: any[]) => call[0]).join("\n");
    expect(output).toContain("/supi:ultraplan authoring is not implemented in this phase");
    expect(output).toContain("/supi:ultraplan next is not implemented in this phase");
    expect(output).toContain("Unknown subcommand \"mystery\"");
  });
});
