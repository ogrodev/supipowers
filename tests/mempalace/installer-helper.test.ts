import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import {
  checkMempalaceProjectInitialized,
  runMempalaceSetup,
  snapshotMempalaceInstall,
  steerMempalaceInitialization,
} from "../../src/mempalace/installer-helper.js";
import type { PlatformPaths } from "../../src/platform/types.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";
import { resolveManagedVenvPaths } from "../../src/mempalace/runtime.js";
import { detectUvPlatform, uvTargetFor } from "../../src/mempalace/uv.js";

function isolatedPaths(rootDir: string): PlatformPaths {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) =>
      path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) =>
      path.join(rootDir, "global", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) => path.join(rootDir, "agent", ...segments),
  };
}

describe("snapshotMempalaceInstall", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-snap-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reports an empty managed install as not ready", () => {
    const paths = isolatedPaths(tmpDir);
    const config = {
      ...DEFAULT_CONFIG,
      mempalace: {
        ...DEFAULT_CONFIG.mempalace,
        managedVenvPath: path.join(tmpDir, "venv-missing"),
      },
    };

    const snap = snapshotMempalaceInstall(paths, tmpDir, config);

    expect(snap.enabled).toBe(true);
    expect(snap.uvInstalled).toBe(false);
    expect(snap.venvInstalled).toBe(false);
    expect(snap.bridgeOk).toBe(true); // bridge ships in this repo's src/
    expect(snap.ready).toBe(false);
    expect(snap.uvPath.endsWith("uv") || snap.uvPath.endsWith("uv.exe")).toBe(true);
  });

  test("reports a fully provisioned managed install as ready", () => {
    const paths = isolatedPaths(tmpDir);
    const venvRoot = path.join(tmpDir, "venv");
    const venv = resolveManagedVenvPaths(venvRoot);
    fs.mkdirSync(path.dirname(venv.python), { recursive: true });
    fs.writeFileSync(venv.python, "");
    const binDir = paths.global("bin");
    fs.mkdirSync(binDir, { recursive: true });
    const uvBinary = process.platform === "win32" ? "uv.exe" : "uv";
    fs.writeFileSync(path.join(binDir, uvBinary), "");

    const config = {
      ...DEFAULT_CONFIG,
      mempalace: {
        ...DEFAULT_CONFIG.mempalace,
        managedVenvPath: venvRoot,
      },
    };

    const snap = snapshotMempalaceInstall(paths, tmpDir, config);

    expect(snap.uvInstalled).toBe(true);
    expect(snap.venvInstalled).toBe(true);
    expect(snap.bridgeOk).toBe(true);
    expect(snap.ready).toBe(true);
  });
});

describe("runMempalaceSetup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-setup-helper-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("invokes setupMempalaceRuntime with the resolved managed bin dir and bridge", async () => {
    const paths = isolatedPaths(tmpDir);
    const venvRoot = path.join(tmpDir, "venv");
    const binDir = paths.global("bin");
    fs.mkdirSync(binDir, { recursive: true });
    const uvPlatform = detectUvPlatform();
    if (!uvPlatform) throw new Error("unsupported test platform");
    const uvPath = path.join(binDir, uvTargetFor(uvPlatform).binary);
    fs.writeFileSync(uvPath, "");
    if (process.platform !== "win32") fs.chmodSync(uvPath, 0o755);
    fs.writeFileSync(path.join(binDir, "uv.version"), "0.5.30\n");

    const config = {
      ...DEFAULT_CONFIG,
      mempalace: { ...DEFAULT_CONFIG.mempalace, managedVenvPath: venvRoot },
    };

    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = mock(async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === uvPath && args[0] === "venv") {
        const venv = resolveManagedVenvPaths(venvRoot);
        fs.mkdirSync(path.dirname(venv.python), { recursive: true });
        fs.writeFileSync(venv.python, "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === uvPath) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: "" };
    });

    const progress: string[] = [];
    const result = await runMempalaceSetup({
      paths,
      cwd: tmpDir,
      config,
      runner,
      onProgress: (m) => progress.push(m),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.details.uvPath).toBe(uvPath);
    expect(result.details.venvPath).toBe(venvRoot);
    expect(result.details.packageVersion).toBe("3.3.4");
    expect(progress.some((m) => m.includes("Provisioning managed Python"))).toBe(true);
    expect(calls.some((c) => c.args[0] === "venv")).toBe(true);
    expect(calls.some((c) => c.args[0] === "pip" && c.args.some((a) => a.startsWith("mempalace==")))).toBe(true);
  });
});

describe("checkMempalaceProjectInitialized + steerMempalaceInitialization", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-init-"));
    repoDir = path.join(tmpDir, "Supi Powers");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "fixture" }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("treats wing as initialized when list_wings returns the wing name", async () => {
    const paths = isolatedPaths(tmpDir);
    const bridge = {
      execute: mock(async () => ({
        ok: true as const,
        action: "list_wings" as const,
        result: { wings: ["supi-powers", "other"] },
        diagnostics: {},
      })),
    };

    const state = await checkMempalaceProjectInitialized({
      paths,
      cwd: repoDir,
      bridge: bridge as any,
    });

    expect(state.wing).toBe("supi-powers");
    expect(state.initialized).toBe(true);
    expect(state.bridgeError).toBeUndefined();
    expect(bridge.execute).toHaveBeenCalledWith({ action: "list_wings" });
  });

  test("treats wing as not initialized when list_wings is missing the wing", async () => {
    const paths = isolatedPaths(tmpDir);
    const bridge = {
      execute: async () => ({
        ok: true as const,
        action: "list_wings" as const,
        result: { wings: [{ name: "other-project" }] },
        diagnostics: {},
      }),
    };

    const state = await checkMempalaceProjectInitialized({
      paths,
      cwd: repoDir,
      bridge: bridge as any,
    });

    expect(state.initialized).toBe(false);
  });

  test("treats wing as not initialized when the bridge call errors", async () => {
    const paths = isolatedPaths(tmpDir);
    const bridge = {
      execute: async () => ({
        ok: false as const,
        action: "list_wings" as const,
        error: { code: "palace_missing", message: "no palace" },
        diagnostics: {},
      }),
    };

    const state = await checkMempalaceProjectInitialized({
      paths,
      cwd: repoDir,
      bridge: bridge as any,
    });

    expect(state.initialized).toBe(false);
    expect(state.bridgeError?.code).toBe("palace_missing");
  });

  test("steerMempalaceInitialization sends a steer message with init guidance", () => {
    const platform = createMockPlatform({ sendMessage: mock() as any });

    const sent = steerMempalaceInitialization(platform, {
      wing: "supipowers",
      cwd: repoDir,
    });

    expect(sent).toBe(true);
    expect((platform.sendMessage as any).mock.calls).toHaveLength(1);
    const [payload, opts] = (platform.sendMessage as any).mock.calls[0];
    expect(payload.customType).toBe("supi-mempalace-init");
    expect(payload.display).toBe("none");
    expect(payload.content[0].text).toContain("supipowers");
    expect(payload.content[0].text).toContain("mempalace(action=\"init\"");
    expect(payload.content[0].text).toContain("mempalace(action=\"mine\"");
    expect(payload.content[0].text).toContain("timeout=30");
    expect(opts.deliverAs).toBe("steer");
    expect(opts.triggerTurn).toBe(true);
  });

  test("steerMempalaceInitialization returns false when sendMessage is unavailable", () => {
    const platform = createMockPlatform({ sendMessage: undefined as any });

    const sent = steerMempalaceInitialization(platform, { wing: "x", cwd: repoDir });

    expect(sent).toBe(false);
  });
});
