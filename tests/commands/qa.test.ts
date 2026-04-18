import { describe, expect, mock, test } from "bun:test";
import type { Platform } from "../../src/platform/types.js";
import { handleQa } from "../../src/commands/qa.js";
import type { QaCommandDependencies } from "../../src/commands/qa.js";
import type { WorkspaceTarget } from "../../src/types.js";

function target(name: string, relativeDir = "."): WorkspaceTarget {
  return {
    id: name,
    name,
    kind: relativeDir === "." ? "root" : "workspace",
    repoRoot: "/repo",
    packageDir: relativeDir === "." ? "/repo" : `/repo/${relativeDir}`,
    manifestPath: relativeDir === "." ? "/repo/package.json" : `/repo/${relativeDir}/package.json`,
    relativeDir,
    version: "1.0.0",
    private: false,
    packageManager: "bun",
  };
}

function createPlatform(): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args.join(" ") === "rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (_cwd: string, ...segments: string[]) => segments.join("/"),
      global: (...segments: string[]) => segments.join("/"),
      agent: (...segments: string[]) => segments.join("/"),
    },
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
  } as unknown as Platform;
}

function createContext(overrides: Partial<any> = {}) {
  return {
    cwd: "/repo",
    hasUI: false,
    ui: {
      select: mock(async () => null),
      notify: mock(),
      input: mock(async () => null),
    },
    ...overrides,
  };
}

function createDependencies(overrides: Partial<QaCommandDependencies> = {}): QaCommandDependencies {
  return {
    loadModelConfig: mock(() => ({ version: "1.0.0", default: null, actions: {} })),
    createModelBridge: mock(() => ({ getModelForRole: () => null, getCurrentModel: () => "unknown" })),
    resolveModelForAction: mock(() => ({ model: "claude-opus-4-6", thinkingLevel: "high", source: "action" })),
    applyModelOverride: mock(async () => undefined),
    resolvePackageManager: mock(() => ({ id: "bun", runScript: () => ({ command: "bun", args: ["run", "dev"] }), buildCommand: { command: "bun", args: ["run", "build"] } })),
    discoverWorkspaceTargets: mock(() => []),
    selectWorkspaceTarget: mock(async () => null),
    loadE2eQaConfig: mock(() => null),
    saveE2eQaConfig: mock(),
    loadE2eMatrix: mock(() => null),
    createNewE2eSession: mock(() => ({ id: "qa-20260416-120000-abcd" } as any)),
    findActiveSession: mock(() => null),
    getSessionDir: mock(() => "/repo/.omp/supipowers/workspaces/packages/web/qa-sessions/qa-20260416-120000-abcd"),
    detectAppType: mock(() => ({
      type: "nextjs-app",
      devCommand: "bun run dev",
      port: 3000,
      baseUrl: "http://localhost:3000",
      isLikelyApp: true,
    })),
    discoverRoutes: mock(() => [
      { path: "/", file: "app/page.tsx", type: "page", hasForm: false },
    ]),
    notifyError: mock(),
    notifyInfo: mock(),
    ...overrides,
  } as QaCommandDependencies;
}

describe("handleQa", () => {
  test("runs QA against the selected package target only", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const rootTarget = target("repo-root");
    const packageTarget = target("@repo/web", "packages/web");
    const deps = createDependencies({
      discoverWorkspaceTargets: mock(() => [rootTarget, packageTarget]),
      selectWorkspaceTarget: mock(async () => packageTarget) as any,
      createNewE2eSession: mock(() => ({ id: "qa-20260416-120000-abcd" } as any)),
      getSessionDir: mock((_paths, _cwd, _sessionId, selectedTarget) =>
        selectedTarget?.relativeDir === "packages/web"
          ? "/repo/.omp/supipowers/workspaces/packages/web/qa-sessions/qa-20260416-120000-abcd"
          : "/repo/.omp/supipowers/qa-sessions/qa-20260416-120000-abcd"),
    });

    await handleQa(platform, ctx, "--target @repo/web", deps);

    expect(deps.detectAppType).toHaveBeenCalledWith("/repo/packages/web");
    expect(deps.discoverRoutes).toHaveBeenCalledWith("/repo/packages/web", "nextjs-app");
    expect(deps.loadE2eQaConfig).toHaveBeenCalledWith(platform.paths, "/repo", packageTarget);
    expect(deps.loadE2eMatrix).toHaveBeenCalledWith(platform.paths, "/repo", packageTarget);
    expect(deps.findActiveSession).toHaveBeenCalledWith(platform.paths, "/repo", packageTarget);
    expect(deps.createNewE2eSession).toHaveBeenCalledWith(platform.paths, "/repo", expect.anything(), packageTarget);
    expect(deps.getSessionDir).toHaveBeenCalledWith(platform.paths, "/repo", "qa-20260416-120000-abcd", packageTarget);

    const message = (platform.sendMessage as any).mock.calls[0]?.[0];
    expect(message.content[0].text).toContain("/repo/packages/web");
    expect(message.content[0].text).not.toContain("/repo/packages/other");
    expect(message.content[0].text).toContain("start-dev-server.ts");
    expect(message.content[0].text).toContain("run-e2e-tests.ts");
    expect(message.content[0].text).not.toContain("start-dev-server.sh");
    expect(message.content[0].text).not.toContain("run-e2e-tests.sh");
  });

  test("auto-selects the only runnable target outside interactive mode", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const rootTarget = target("repo-root");
    const packageTarget = target("@repo/web", "packages/web");
    const deps = createDependencies({
      discoverWorkspaceTargets: mock(() => [rootTarget, packageTarget]),
      selectWorkspaceTarget: mock(async () => null) as any,
      detectAppType: mock((targetDir: string) => {
        if (targetDir === "/repo") throw new Error("no app metadata");
        return {
          type: "nextjs-app",
          devCommand: "bun run dev",
          port: 3000,
          baseUrl: "http://localhost:3000",
          isLikelyApp: true,
        };
      }) as any,
      discoverRoutes: mock((targetDir: string) => {
        if (targetDir === "/repo/packages/web") {
          return [{ path: "/", file: "app/page.tsx", type: "page", hasForm: false }];
        }
        throw new Error(`unexpected route discovery for ${targetDir}`);
      }) as any,
    });

    await handleQa(platform, ctx, undefined, deps);

    expect(deps.selectWorkspaceTarget).not.toHaveBeenCalled();
    expect(deps.detectAppType).toHaveBeenCalledTimes(2);
    expect(deps.detectAppType).toHaveBeenNthCalledWith(1, "/repo");
    expect(deps.detectAppType).toHaveBeenNthCalledWith(2, "/repo/packages/web");
    expect(deps.discoverRoutes).toHaveBeenCalledTimes(1);
    expect(deps.createNewE2eSession).toHaveBeenCalledWith(platform.paths, "/repo", expect.anything(), packageTarget);
  });

  test("keeps an explicitly requested non-runnable target selected", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const rootTarget = target("repo-root");
    const packageTarget = target("@repo/web", "packages/web");
    const deps = createDependencies({
      discoverWorkspaceTargets: mock(() => [rootTarget, packageTarget]),
      selectWorkspaceTarget: mock(async (_ctx, options: Array<{ target: WorkspaceTarget }>, requestedTarget) =>
        options.find((option) => option.target.name === requestedTarget)?.target ?? null,
      ) as any,
      detectAppType: mock((targetDir: string) => {
        if (targetDir === "/repo") {
          return {
            type: "generic",
            devCommand: "npm run dev",
            port: 3000,
            baseUrl: "http://localhost:3000",
            isLikelyApp: false,
          };
        }

        return {
          type: "nextjs-app",
          devCommand: "bun run dev",
          port: 3000,
          baseUrl: "http://localhost:3000",
          isLikelyApp: true,
        };
      }) as any,
      discoverRoutes: mock((targetDir: string) => (targetDir === "/repo" ? [] : [{ path: "/", file: "app/page.tsx", type: "page", hasForm: false }])) as any,
    });

    await handleQa(platform, ctx, "--target repo-root", deps);

    expect(deps.notifyError).toHaveBeenCalledWith(
      ctx,
      "Selected target is not a runnable app",
      expect.stringContaining("repo-root"),
    );
    expect(deps.createNewE2eSession).not.toHaveBeenCalled();
    expect(platform.sendMessage).not.toHaveBeenCalled();
  });

  test("discovers QA targets from the repo root when invoked inside a package", async () => {
    const platform = createPlatform();
    const ctx = createContext({ cwd: "/repo/packages/api" });
    const apiTarget = target("@repo/api", "packages/api");
    const webTarget = target("@repo/web", "packages/web");
    const deps = createDependencies({
      discoverWorkspaceTargets: mock((cwd: string) => cwd === "/repo" ? [apiTarget, webTarget] : [apiTarget]) as any,
      selectWorkspaceTarget: mock(async () => webTarget) as any,
    });

    await handleQa(platform, ctx, "--target @repo/web", deps);

    expect(deps.resolvePackageManager).toHaveBeenCalledWith("/repo");
    expect(deps.discoverWorkspaceTargets).toHaveBeenCalledWith("/repo", "bun");
    expect(deps.detectAppType).toHaveBeenCalledWith("/repo/packages/web");
  });

  test("rejects targets that do not look like runnable apps", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const packageTarget = target("@repo/lib", "packages/lib");
    const deps = createDependencies({
      discoverWorkspaceTargets: mock(() => [packageTarget]),
      selectWorkspaceTarget: mock(async () => packageTarget) as any,
      detectAppType: mock(() => ({
        type: "generic" as const,
        devCommand: "npm run dev",
        port: 3000,
        baseUrl: "http://localhost:3000",
        isLikelyApp: false,
      })),
      discoverRoutes: mock(() => []),
    });

    await handleQa(platform, ctx, "--target @repo/lib", deps);

    expect(deps.notifyError).toHaveBeenCalledWith(
      ctx,
      "Selected target is not a runnable app",
      expect.stringContaining("@repo/lib"),
    );
    expect(platform.sendMessage).not.toHaveBeenCalled();
  });

  test("saves per-target config when setup wizard runs", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      hasUI: true,
      ui: {
        select: mock(async (title: string) => {
          if (title === "QA target") return "@repo/web — packages/web — workspace package";
          if (title === "App type") return "nextjs-app — Next.js App Router";
          if (title === "Max test retries") return "2 (recommended)";
          return null;
        }),
        notify: mock(),
        input: mock(async (_label: string, initial: string) => initial),
      },
    });
    const packageTarget = target("@repo/web", "packages/web");
    const deps = createDependencies({
      discoverWorkspaceTargets: mock(() => [packageTarget]),
      selectWorkspaceTarget: mock(async () => packageTarget) as any,
    });

    await handleQa(platform, ctx, undefined, deps);

    expect(deps.saveE2eQaConfig).toHaveBeenCalledWith(
      platform.paths,
      "/repo",
      expect.objectContaining({ app: expect.objectContaining({ type: "nextjs-app" }) }),
      packageTarget,
    );
  });
});
