import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleMemory, registerMemoryCommand } from "../../src/commands/memory.js";
import { createMockContext, createMockPlatform } from "../../src/platform/test-utils.js";
import { createPaths, type PlatformPaths } from "../../src/platform/types.js";
import { resolveManagedVenvPaths } from "../../src/mempalace/runtime.js";
import { detectUvPlatform, uvTargetFor } from "../../src/mempalace/uv.js";
import { MEMPALACE_PACKAGE_VERSION } from "../../src/mempalace/upstream-limits.js";

function isolatedPaths(rootDir: string): PlatformPaths {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) => path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) => path.join(rootDir, "global", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) => path.join(rootDir, "agent", ...segments),
  };
}

describe("/supi:memory command", () => {
  let tmpDir: string;
  let cwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-memory-cmd-"));
    cwd = path.join(tmpDir, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("registers /supi:memory with description", () => {
    const platform = createMockPlatform();
    registerMemoryCommand(platform);
    const calls = (platform.registerCommand as any).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("supi:memory");
    expect(calls[0][1].description).toContain("MemPalace");
  });

  test("registers argument completions matching the typed prefix", () => {
    const platform = createMockPlatform();
    registerMemoryCommand(platform);
    const definition = (platform.registerCommand as any).mock.calls[0][1];
    expect(typeof definition.getArgumentCompletions).toBe("function");

    const all = definition.getArgumentCompletions("");
    expect(all?.map((entry: any) => entry.label)).toEqual(["status", "setup"]);
    expect(all?.every((entry: any) => entry.value.endsWith(" "))).toBe(true);

    const setupOnly = definition.getArgumentCompletions("se");
    expect(setupOnly?.map((entry: any) => entry.label)).toEqual(["setup"]);
    expect(setupOnly?.[0].description).toContain("Install or repair");

    expect(definition.getArgumentCompletions("nope")).toBeNull();
  });

  test("bare command shows help with subcommands", () => {
    const notify = mock();
    const platform = createMockPlatform({ paths: isolatedPaths(tmpDir) });
    const ctx = createMockContext({ cwd, ui: { ...createMockContext().ui, notify } });

    handleMemory(platform, ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("/supi:memory");
    expect(notify.mock.calls[0][0]).toContain("setup");
    expect(notify.mock.calls[0][0]).toContain("status");
    expect(notify.mock.calls[0][1]).toBe("info");
  });

  test("status reports missing managed venv", () => {
    const notify = mock();
    const platform = createMockPlatform({ paths: isolatedPaths(tmpDir) });
    const ctx = createMockContext({ cwd, ui: { ...createMockContext().ui, notify } });

    handleMemory(platform, ctx, "status");

    expect(notify).toHaveBeenCalledTimes(1);
    const [text, level] = notify.mock.calls[0];
    expect(text).toContain("/supi:memory status");
    expect(text).toContain("missing");
    expect(text).toContain("Run `/supi:memory setup`");
    expect(level).toBe("info");
  });

  test("setup runs the uv-driven install pipeline and reports success", async () => {
    const venvRoot = path.join(tmpDir, "venv");
    const projectConfigDir = path.join(cwd, ".omp", "supipowers");
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, "config.json"),
      JSON.stringify({ mempalace: { managedVenvPath: venvRoot } }),
    );

    // Pre-stage a managed uv binary so ensureUv hits the cached path and skips download.
    const platform = createMockPlatform({ paths: isolatedPaths(tmpDir) });
    const binDir = platform.paths.global("bin");
    const uvPlatform = detectUvPlatform();
    if (!uvPlatform) throw new Error("unsupported test platform");
    const uvPath = path.join(binDir, uvTargetFor(uvPlatform).binary);
    const venv = resolveManagedVenvPaths(venvRoot);
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(uvPath, "");
    if (process.platform !== "win32") fs.chmodSync(uvPath, 0o755);
    fs.writeFileSync(path.join(binDir, "uv.version"), "0.5.30\n");

    const exec = mock(async (command: string, args: string[]) => {
      if (command === uvPath && args[0] === "venv") {
        fs.mkdirSync(path.dirname(venv.python), { recursive: true });
        fs.writeFileSync(venv.python, "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === uvPath) return { code: 0, stdout: "", stderr: "" };
      // Bridge subprocess invocations: command is the venv python.
      return { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: "" };
    });
    (platform as any).exec = exec;

    const notify = mock();
    const ctx = createMockContext({ cwd, ui: { ...createMockContext().ui, notify } });

    handleMemory(platform, ctx, "setup");
    while (
      !(notify.mock.calls as any[])
        .map((call) => call[0] as string)
        .some((msg) => msg.includes("Steering the agent to initialize project wing"))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const messages = notify.mock.calls.map((call: any[]) => call[0] as string);
    expect(messages.some((msg) => msg.includes("Provisioning managed Python 3.12 via uv"))).toBe(true);
    expect(messages.some((msg) => msg.includes(`Installing mempalace==${MEMPALACE_PACKAGE_VERSION} from PyPI`))).toBe(true);
    expect(messages.some((msg) => msg.includes("MemPalace setup complete."))).toBe(true);
    expect(messages.some((msg) => msg.includes("uv:"))).toBe(true);
    expect(messages.some((msg) => msg.includes("python:  3.12 (managed by uv)"))).toBe(true);
    expect((platform.sendMessage as any).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect((platform.sendMessage as any).mock.calls[0][0].customType).toBe("supi-mempalace-init");
    expect(exec).toHaveBeenCalled();
  }, process.platform === "win32" ? 60_000 : undefined);
  test("setup surfaces install failures with remediation", async () => {
    const venvRoot = path.join(tmpDir, "venv");
    const projectConfigDir = path.join(cwd, ".omp", "supipowers");
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, "config.json"),
      JSON.stringify({ mempalace: { managedVenvPath: venvRoot } }),
    );

    const platform = createMockPlatform({ paths: isolatedPaths(tmpDir) });
    const binDir = platform.paths.global("bin");
    const uvPlatform = detectUvPlatform();
    if (!uvPlatform) throw new Error("unsupported test platform");
    const uvPath = path.join(binDir, uvTargetFor(uvPlatform).binary);
    const venv = resolveManagedVenvPaths(venvRoot);
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(uvPath, "");
    if (process.platform !== "win32") fs.chmodSync(uvPath, 0o755);
    fs.writeFileSync(path.join(binDir, "uv.version"), "0.5.30\n");

    (platform as any).exec = mock(async (command: string, args: string[]) => {
      if (command === uvPath && args[0] === "venv") {
        fs.mkdirSync(path.dirname(venv.python), { recursive: true });
        fs.writeFileSync(venv.python, "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.some((entry) => entry.startsWith("mempalace=="))) {
        return { code: 1, stdout: "", stderr: "ERROR: dependency conflict" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const notify = mock();
    const ctx = createMockContext({ cwd, ui: { ...createMockContext().ui, notify } });

    handleMemory(platform, ctx, "setup");
    while ((notify.mock.calls.at(-1)?.[1] as string | undefined) !== "error") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const last = notify.mock.calls.at(-1)![0] as string;
    expect(last).toContain("MemPalace setup failed");
    expect(last).toContain("setup_failed");
    expect(last).toContain("ERROR: dependency conflict");
    expect(last).toContain("astral-sh/uv");
  });

  test("rejects unknown subcommands", () => {
    const notify = mock();
    const platform = createMockPlatform({ paths: isolatedPaths(tmpDir) });
    const ctx = createMockContext({ cwd, ui: { ...createMockContext().ui, notify } });

    handleMemory(platform, ctx, "destroy");

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("Unknown /supi:memory subcommand");
    expect(notify.mock.calls[0][1]).toBe("warning");
  });
});
