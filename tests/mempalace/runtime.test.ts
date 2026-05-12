import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildMempalaceCliArgs,
  discoverPython,
  resolveBridgeScriptPath,
  resolveManagedVenvPaths,
  runBridgeRequest,
  setupMempalaceRuntime,
} from "../../src/mempalace/runtime.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { resolveMempalaceConfig } from "../../src/mempalace/config.js";
import { createPaths } from "../../src/platform/types.js";
import { detectUvPlatform, uvTargetFor } from "../../src/mempalace/uv.js";

describe("mempalace runtime bridge path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-runtime-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves bundled bridge path relative to the runtime module URL", () => {
    const moduleDir = path.join(tmpDir, "src", "mempalace");
    const bridgeDir = path.join(moduleDir, "python");
    fs.mkdirSync(bridgeDir, { recursive: true });
    const bridgePath = path.join(bridgeDir, "mempalace_bridge.py");
    fs.writeFileSync(bridgePath, "print('ok')\n");

    const resolved = resolveBridgeScriptPath({
      moduleUrl: pathToFileURL(path.join(moduleDir, "runtime.ts")).href,
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.path).toBe(bridgePath);
  });

  test("returns bridge_not_found when the resolved bridge file is missing", () => {
    const moduleDir = path.join(tmpDir, "src", "mempalace");
    fs.mkdirSync(moduleDir, { recursive: true });

    const resolved = resolveBridgeScriptPath({
      moduleUrl: pathToFileURL(path.join(moduleDir, "runtime.ts")).href,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected missing bridge");
    expect(resolved.error.code).toBe("bridge_not_found");
    expect(resolved.error.message).toContain("mempalace_bridge.py");
    expect(resolved.path).toBe(path.join(moduleDir, "python", "mempalace_bridge.py"));
  });
  test("falls back to an installed extension root when runtime module is temp-copied", () => {
    const tempModuleDir = path.join(tmpDir, "omp-legacy-pi-file", "module-copy");
    fs.mkdirSync(tempModuleDir, { recursive: true });
    const extensionRoot = path.join(tmpDir, "agent", "extensions", "supipowers");
    const bridgeDir = path.join(extensionRoot, "src", "mempalace", "python");
    fs.mkdirSync(bridgeDir, { recursive: true });
    const bridgePath = path.join(bridgeDir, "mempalace_bridge.py");
    fs.writeFileSync(bridgePath, "print('ok')\n");

    const resolved = resolveBridgeScriptPath({
      moduleUrl: pathToFileURL(path.join(tempModuleDir, "runtime.ts")).href,
      extensionRoots: [extensionRoot],
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.path).toBe(bridgePath);
  });

});

describe("mempalace runtime Python discovery", () => {
  test("uses a configured Python executable with argument arrays", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await discoverPython({
      configuredPython: "/opt/python/bin/python3",
      runner: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, stdout: "Python 3.12.1\n", stderr: "" };
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.pythonPath).toBe("/opt/python/bin/python3");
    expect(calls).toEqual([{ command: "/opt/python/bin/python3", args: ["--version"] }]);
  });

  test("reports python_missing when no candidate can run", async () => {
    const result = await discoverPython({
      candidates: ["python404", "python405"],
      runner: async () => {
        throw new Error("ENOENT");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected python_missing");
    expect(result.error.code).toBe("python_missing");
    expect(result.error.remediation).toContain("Python 3.9+");
  });

  test("reports unsupported configured Python versions", async () => {
    const result = await discoverPython({
      configuredPython: "python3.8",
      runner: async () => ({ code: 0, stdout: "", stderr: "Python 3.8.18\n" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unsupported version");
    expect(result.error.code).toBe("python_version_unsupported");
    expect(result.error.message).toContain("3.8.18");
  });

  test("resolves managed venv executable paths for POSIX and Windows shapes", () => {
    expect(resolveManagedVenvPaths("/tmp/mempalace-venv", "posix")).toEqual({
      root: "/tmp/mempalace-venv",
      python: path.join("/tmp/mempalace-venv", "bin", "python"),
      pip: path.join("/tmp/mempalace-venv", "bin", "pip"),
    });

    expect(resolveManagedVenvPaths("C:\\\\Users\\\\me\\\\venv", "win32")).toEqual({
      root: "C:\\\\Users\\\\me\\\\venv",
      python: path.win32.join("C:\\\\Users\\\\me\\\\venv", "Scripts", "python.exe"),
      pip: path.win32.join("C:\\\\Users\\\\me\\\\venv", "Scripts", "pip.exe"),
    });
  });
});

describe("mempalace runtime bridge subprocess protocol", () => {
  test("sends exactly one JSON request on stdin and parses success JSON", async () => {
    const calls: any[] = [];
    const result = await runBridgeRequest({
      pythonPath: "python",
      bridgeScriptPath: "/bridge/mempalace_bridge.py",
      timeoutMs: 1000,
      request: { action: "status", params: {}, options: { cwd: "/repo" } },
      runner: async (command, args, options) => {
        calls.push({ command, args, input: options?.input });
        return { code: 0, stdout: JSON.stringify({ ok: true, result: { ready: true } }), stderr: "" };
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.response).toEqual({ ok: true, result: { ready: true } });
    expect(calls).toEqual([
      {
        command: "python",
        args: ["/bridge/mempalace_bridge.py"],
        input: JSON.stringify({ action: "status", params: {}, options: { cwd: "/repo" } }),
      },
    ]);
  });

  test("preserves MemPalace domain error JSON", async () => {
    const result = await runBridgeRequest({
      pythonPath: "python",
      bridgeScriptPath: "/bridge.py",
      timeoutMs: 1000,
      request: { action: "search", params: { query: "x" }, options: {} },
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({ ok: false, error: { code: "palace_missing", message: "No palace" } }),
        stderr: "warning only\n",
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.response.ok).toBe(false);
    expect(result.stderr).toBe("warning only\n");
  });

  test("returns bridge_protocol_error for malformed stdout", async () => {
    const result = await runBridgeRequest({
      pythonPath: "python",
      bridgeScriptPath: "/bridge.py",
      timeoutMs: 1000,
      request: { action: "status", params: {}, options: {} },
      runner: async () => ({ code: 0, stdout: "{not-json", stderr: "warn" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("bridge_protocol_error");
    expect(result.stdoutPreview).toBe("{not-json");
    expect(result.stderrTail).toBe("warn");
  });

  test("returns bridge_process_failed for non-zero exits", async () => {
    const result = await runBridgeRequest({
      pythonPath: "python",
      bridgeScriptPath: "/bridge.py",
      timeoutMs: 1000,
      request: { action: "status", params: {}, options: {} },
      runner: async () => ({ code: 2, stdout: "", stderr: "boom" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("bridge_process_failed");
    expect(result.stderrTail).toBe("boom");
  });

  test("returns bridge_timeout when the subprocess exceeds timeout", async () => {
    const result = await runBridgeRequest({
      pythonPath: "python",
      bridgeScriptPath: "/bridge.py",
      timeoutMs: 5,
      request: { action: "status", params: {}, options: {} },
      runner: async () => new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: "{}", stderr: "" }), 50)),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("bridge_timeout");
  });
});

describe("mempalace runtime setup flow (uv-driven)", () => {
  test("ensures uv, provisions managed Python, creates venv, installs official package, verifies bridge", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-setup-"));
    const binDir = path.join(cwd, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const uvPlatform = detectUvPlatform();
    if (!uvPlatform) throw new Error("unsupported test platform");
    const uvPath = path.join(binDir, uvTargetFor(uvPlatform).binary);
    fs.writeFileSync(uvPath, "#!/usr/bin/env true\n");
    if (process.platform !== "win32") fs.chmodSync(uvPath, 0o755);
    fs.writeFileSync(path.join(binDir, "uv.version"), "0.5.30\n");

    const baseConfig = {
      ...DEFAULT_CONFIG,
      mempalace: {
        ...DEFAULT_CONFIG.mempalace,
        // Override defaults so this test never touches the developer's real
        // ~/.omp/supipowers/mempalace-venv. setupMempalaceRuntime() rmSync's
        // managedVenvPath directly (bypasses the mocked runner) and would
        // wipe the live venv on every test run.
        managedVenvPath: path.join(cwd, "venv"),
        palacePath: path.join(cwd, "palace"),
      },
    };
    const config = resolveMempalaceConfig(baseConfig, cwd, createPaths(".omp"));
    const venv = resolveManagedVenvPaths(config.managedVenvPath);
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const progress: string[] = [];

    try {
      const result = await setupMempalaceRuntime({
        cwd,
        config,
        bridgeScriptPath: "/bridge.py",
        managedBinDir: binDir,
        runner: async (command, args, runnerOptions) => {
          calls.push({ command, args, input: runnerOptions?.input });
          if (runnerOptions?.input?.includes("\"action\":\"version\"")) {
            return { code: 0, stdout: JSON.stringify({ ok: true, result: { version: "3.3.4" } }), stderr: "" };
          }
          if (runnerOptions?.input?.includes("\"action\":\"status\"")) {
            return { code: 0, stdout: JSON.stringify({ ok: true, result: { ready: true } }), stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        onProgress: (message) => progress.push(message),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(calls.map((call) => [call.command, call.args])).toEqual([
        [uvPath, ["python", "install", "3.12"]],
        [uvPath, ["venv", config.managedVenvPath, "--python", "3.12"]],
        [uvPath, ["pip", "install", "--python", venv.python, "mempalace==3.3.4"]],
        [venv.python, ["/bridge.py"]],
        [venv.python, ["/bridge.py"]],
      ]);
      expect(progress).toEqual([
        "Provisioning managed Python 3.12 via uv",
        "Creating managed MemPalace virtual environment",
        "Installing mempalace==3.3.4 from PyPI",
        "Verifying MemPalace bridge",
        "Checking MemPalace palace status",
      ]);
      expect(result.details.uvPath).toBe(uvPath);
      expect(result.details.uvVersion).toBe("0.5.30");
      expect(result.details.managedPython).toBe("3.12");
      expect(result.details.packageVersion).toBe("3.3.4");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("setup failure surfaces uv stderr in the user-visible message", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-setup-"));
    const binDir = path.join(cwd, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const uvPlatform = detectUvPlatform();
    if (!uvPlatform) throw new Error("unsupported test platform");
    const uvPath = path.join(binDir, uvTargetFor(uvPlatform).binary);
    fs.writeFileSync(uvPath, "");
    if (process.platform !== "win32") fs.chmodSync(uvPath, 0o755);
    fs.writeFileSync(path.join(binDir, "uv.version"), "0.5.30\n");

    const baseConfig = {
      ...DEFAULT_CONFIG,
      mempalace: {
        ...DEFAULT_CONFIG.mempalace,
        managedVenvPath: path.join(cwd, "venv"),
        palacePath: path.join(cwd, "palace"),
      },
    };
    const config = resolveMempalaceConfig(baseConfig, cwd, createPaths(".omp"));

    try {
      const result = await setupMempalaceRuntime({
        cwd,
        config,
        bridgeScriptPath: "/bridge.py",
        managedBinDir: binDir,
        runner: async (_command, args) => {
          if (args.some((a) => a.startsWith("mempalace=="))) {
            return { code: 1, stdout: "", stderr: "ERROR: dependency conflict" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected setup failure");
      expect(result.error.code).toBe("setup_failed");
      expect(result.error.message).toContain("Failed to install mempalace==3.3.4");
      expect(result.error.message).toContain("ERROR: dependency conflict");
      expect(result.error.remediation).toContain("PyPI");
      expect(result.error.remediation).toContain("astral-sh/uv");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("mempalace runtime native CLI argument building", () => {
  test("builds native action CLI argument arrays without shell interpolation", () => {
    expect(buildMempalaceCliArgs("init", { dir: ".", yes: true })).toEqual(["init", ".", "--yes"]);
    expect(buildMempalaceCliArgs("mine", { dir: "~/repo/${USER}", limit: 10, include_ignored: true })).toEqual([
      "mine",
      "~/repo/${USER}",
      "--limit",
      "10",
      "--include-ignored",
    ]);
    expect(buildMempalaceCliArgs("split", { source_file: "logs/mega transcript.md", mode: "conversation" })).toEqual([
      "split",
      "logs/mega transcript.md",
      "--mode",
      "conversation",
    ]);
    expect(buildMempalaceCliArgs("repair", { dir: ".", dry_run: true })).toEqual(["repair", ".", "--dry-run"]);
  });
});
