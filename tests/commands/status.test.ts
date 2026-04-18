import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Platform } from "../../src/platform/types.js";
import { formatOverviewStatus, showStatusDialog } from "../../src/commands/status.js";
import { appendReliabilityRecord } from "../../src/storage/reliability-metrics.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supipowers-status-"));
  tempDirs.push(dir);
  return dir;
}

function createPlatform(): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (cwd: string, ...segments: string[]) => path.join(cwd, ".omp", "supipowers", ...segments),
      global: (...segments: string[]) => path.join(os.tmpdir(), "supipowers-global-test", ...segments),
      agent: (...segments: string[]) => path.join(os.tmpdir(), "supipowers-agent-test", ...segments),
    },
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
  } as unknown as Platform;
}

function createContext(cwd: string) {
  return {
    cwd,
    hasUI: true,
    ui: { select: mock(async () => null), notify: mock() },
  } as any;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function repoStatePath(repoRoot: string, ...segments: string[]): string {
  return path.join(repoRoot, ".omp", "supipowers", ...segments);
}

function workspaceStatePath(repoRoot: string, workspaceRelativeDir: string, ...segments: string[]): string {
  return repoStatePath(repoRoot, "workspaces", ...workspaceRelativeDir.split("/"), ...segments);
}

function writeReviewReport(filePath: string, overallStatus: "passed" | "failed" | "blocked"): void {
  writeJson(filePath, {
    timestamp: "2026-04-16T10:15:00.000Z",
    selectedGates: ["lsp-diagnostics"],
    gates: [
      {
        gate: "lsp-diagnostics",
        status: overallStatus === "passed" ? "passed" : "failed",
        summary: "done",
        issues: [],
      },
    ],
    summary: {
      passed: overallStatus === "passed" ? 1 : 0,
      failed: overallStatus === "passed" ? 0 : 1,
      skipped: 0,
      blocked: overallStatus === "blocked" ? 1 : 0,
    },
    overallStatus,
  });
}

function getSelectOptions(ctx: ReturnType<typeof createContext>): string[] {
  return (ctx.ui.select as ReturnType<typeof mock>).mock.calls[0]?.[1] as string[];
}

describe("showStatusDialog", () => {
  test("surfaces root config inspection errors instead of throwing", async () => {
    const repoRoot = createTempRepo();
    writeJson(path.join(repoRoot, "package.json"), {
      name: "single-app",
      version: "1.0.0",
    });
    writeText(repoStatePath(repoRoot, "config.json"), "{\n");

    const platform = createPlatform();
    const ctx = createContext(repoRoot);

    await showStatusDialog(platform, ctx);

    expect(getSelectOptions(ctx)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Config error: repository config"),
      ]),
    );
  });

  test("keeps single-package status compact", async () => {
    const repoRoot = createTempRepo();
    writeJson(path.join(repoRoot, "package.json"), {
      name: "single-app",
      version: "1.0.0",
    });
    writeText(repoStatePath(repoRoot, "plans", "plan-a.md"), "# plan\n");
    writeReviewReport(repoStatePath(repoRoot, "reports", "review-2026-04-16.json"), "passed");

    const platform = createPlatform();
    const ctx = createContext(repoRoot);

    await showStatusDialog(platform, ctx);

    const options = getSelectOptions(ctx);
    expect(options).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Gates:"),
        "Plans: 1",
        "  · plan-a.md",
        "Last checks: 2026-04-16 (passed)",
      ]),
    );
    expect(options).not.toEqual(expect.arrayContaining([expect.stringContaining("Packages:")]));
    expect(options).not.toEqual(expect.arrayContaining([expect.stringContaining("(root)")]));
  });

  test("resolves monorepo status from the repo root when invoked inside a workspace", async () => {
    const repoRoot = createTempRepo();
    const workspaceDir = path.join(repoRoot, "packages", "api");
    writeJson(path.join(repoRoot, "package.json"), {
      name: "root-app",
      version: "1.0.0",
      workspaces: ["packages/*"],
    });
    writeJson(path.join(workspaceDir, "package.json"), {
      name: "api",
      version: "1.0.0",
    });
    writeJson(path.join(repoRoot, "packages", "web", "package.json"), {
      name: "web",
      version: "1.0.0",
    });
    writeText(repoStatePath(repoRoot, "plans", "root-plan.md"), "# root plan\n");

    const platform = createPlatform();
    const ctx = createContext(workspaceDir);

    await showStatusDialog(platform, ctx);
    expect((platform.exec as ReturnType<typeof mock>).mock.calls[0]).toEqual([
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: workspaceDir },
    ]);

    expect(getSelectOptions(ctx)).toEqual(
      expect.arrayContaining([
        "Packages: 3 targets · 2 workspaces",
        "root-app (root)",
        "api (packages/api)",
        "web (packages/web)",
        "    · root-plan.md",
      ]),
    );
  });

  test("shows package-aware aggregate status for monorepos", async () => {
    const repoRoot = createTempRepo();
    writeJson(path.join(repoRoot, "package.json"), {
      name: "root-app",
      version: "1.0.0",
      workspaces: ["packages/*"],
    });
    writeJson(path.join(repoRoot, "packages", "api", "package.json"), {
      name: "api",
      version: "1.0.0",
    });
    writeJson(path.join(repoRoot, "packages", "web", "package.json"), {
      name: "web",
      version: "1.0.0",
    });
    writeText(repoStatePath(repoRoot, "plans", "root-plan.md"), "# root plan\n");
    writeReviewReport(
      workspaceStatePath(repoRoot, "packages/api", "reports", "review-2026-04-16.json"),
      "passed",
    );

    const platform = createPlatform();
    const ctx = createContext(repoRoot);

    await showStatusDialog(platform, ctx);

    const options = getSelectOptions(ctx);
    expect(options).toEqual(
      expect.arrayContaining([
        "Packages: 3 targets · 2 workspaces",
        "Artifacts: 1 with plans · 1 with reports",
        "root-app (root)",
        "api (packages/api)",
        "web (packages/web)",
        "    · root-plan.md",
        "  Last checks: 2026-04-16 (passed)",
      ]),
    );

    expect(await formatOverviewStatus(platform, ctx)).toEqual([
      "Packages: 3 targets · 2 workspaces",
      "Config issues: none",
      "Plans: root: 1",
      "Last checks: api: 2026-04-16 (passed)",
    ]);
  });

  test("renders reliability empty state when no records exist", async () => {
    const repoRoot = createTempRepo();
    writeJson(path.join(repoRoot, "package.json"), { name: "lonely", version: "1.0.0" });

    const platform = createPlatform();
    const ctx = createContext(repoRoot);

    await showStatusDialog(platform, ctx);

    expect(getSelectOptions(ctx)).toEqual(
      expect.arrayContaining([
        "Reliability: no records yet (metrics appear after AI-heavy commands run).",
      ]),
    );
  });

  test("renders a reliability row per command from stored records", async () => {
    const repoRoot = createTempRepo();
    writeJson(path.join(repoRoot, "package.json"), { name: "reliable", version: "1.0.0" });

    const platform = createPlatform();
    const ctx = createContext(repoRoot);

    appendReliabilityRecord(platform.paths, repoRoot, {
      ts: "2026-04-10T10:00:00.000Z",
      command: "plan",
      outcome: "ok",
      attempts: 1,
    });
    appendReliabilityRecord(platform.paths, repoRoot, {
      ts: "2026-04-11T10:00:00.000Z",
      command: "plan",
      outcome: "blocked",
      attempts: 2,
    });
    appendReliabilityRecord(platform.paths, repoRoot, {
      ts: "2026-04-12T10:00:00.000Z",
      command: "commit",
      outcome: "fallback",
      attempts: 1,
    });

    await showStatusDialog(platform, ctx);

    const options = getSelectOptions(ctx);
    expect(options).toEqual(
      expect.arrayContaining([
        "Reliability (last 3 records)",
      ]),
    );
    const planRow = options.find((line) => line.startsWith("plan "));
    const commitRow = options.find((line) => line.startsWith("commit"));
    expect(planRow).toContain("ok 1");
    expect(planRow).toContain("blocked 1");
    expect(planRow).toContain("avg-attempts 1.5");
    expect(planRow).toContain("last 2026-04-11");
    expect(commitRow).toContain("fallback 1");
    expect(commitRow).toContain("avg-attempts 1.0");
  });
});
