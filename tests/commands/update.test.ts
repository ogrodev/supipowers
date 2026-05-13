import { describe, expect, it, test, mock, beforeEach, afterEach } from "bun:test";
import { buildUpdateOptions, handleUpdate } from "../../src/commands/update.js";
import { createMockPlatform, createMockContext } from "../../src/platform/test-utils.js";
import type { DependencyStatus } from "../../src/deps/registry.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveManagedVenvPaths } from "../../src/mempalace/runtime.js";
import { detectUvPlatform, uvTargetFor } from "../../src/mempalace/uv.js";
import { MEMPALACE_PACKAGE_VERSION } from "../../src/mempalace/upstream-limits.js";
function makeDep(overrides: Partial<DependencyStatus> = {}): DependencyStatus {
  return {
    name: "test-tool",
    binary: "test-tool",
    required: false,
    category: "lsp",
    description: "A test tool",
    installCmd: "npm install -g test-tool",
    url: "https://example.com",
    installed: false,
    ...overrides,
  };
}

describe("buildUpdateOptions", () => {
  it("returns 4 options with correct missing count", () => {
    const missing: DependencyStatus[] = [
      makeDep({ name: "TypeScript LSP", installCmd: "bun add -g typescript-language-server typescript" }),
      makeDep({ name: "context-mode", installCmd: "npm install -g context-mode" }),
      makeDep({ name: "pyright", installCmd: "pip install pyright" }),
    ];

    const options = buildUpdateOptions(missing);

    expect(options).toHaveLength(4);
    expect(options[0]).toBe("Update supipowers only");
    expect(options[1]).toBe("Update supipowers + install missing tools (3 missing)");
    expect(options[2]).toBe("Update supipowers + reinstall all tools (latest)");
    expect(options[3]).toBe("Cancel");
  });

  it("shows '(all installed)' when no deps are missing", () => {
    const options = buildUpdateOptions([]);

    expect(options).toHaveLength(4);
    expect(options[1]).toBe("Update supipowers + install missing tools (all installed)");
  });

  it("only counts deps with installCmd in the missing count", () => {
    const missing: DependencyStatus[] = [
      makeDep({ name: "Git", installCmd: null }),         // no installCmd — should not count
      makeDep({ name: "bun:sqlite", installCmd: null }),  // no installCmd — should not count
      makeDep({ name: "TypeScript LSP", installCmd: "bun add -g typescript-language-server typescript" }), // has installCmd
    ];

    const options = buildUpdateOptions(missing);

    // Only TypeScript LSP has installCmd, so count should be 1
    expect(options[1]).toBe("Update supipowers + install missing tools (1 missing)");
  });

  it("shows '(all installed)' when all missing deps lack installCmd", () => {
    const missing: DependencyStatus[] = [
      makeDep({ name: "Git", installCmd: null }),
      makeDep({ name: "bun:sqlite", installCmd: null }),
    ];

    const options = buildUpdateOptions(missing);

    expect(options[1]).toBe("Update supipowers + install missing tools (all installed)");
  });
});



describe("handleUpdate — dependency install", () => {
  let tmpDir: string;
  let extDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-update-test-"));
    extDir = path.join(tmpDir, "agent", "extensions", "supipowers");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("calls bun install in extension directory after file copy", async () => {
    const execCalls: Array<{ cmd: string; args: string[]; opts?: any }> = [];

    // Create a fake installed package so updateSupipowers finds it
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );

    const platform = createMockPlatform({
      paths: {
        dotDir: ".omp",
        dotDirDisplay: ".omp",
        project: (cwd: string, ...s: string[]) => path.join(cwd, ".omp", "supipowers", ...s),
        global: (...s: string[]) => path.join(tmpDir, "global", ...s),
        agent: (...s: string[]) => path.join(tmpDir, "agent", ...s),
      },
      exec: mock(async (cmd: string, args: string[], opts?: any) => {
        execCalls.push({ cmd, args, opts });

        // npm view → return a newer version to trigger update
        if (cmd === "npm" && args[0] === "view") {
          return { stdout: "2.0.0\n", stderr: "", code: 0 };
        }

        // npm install --prefix → simulate downloading the package
        if (cmd === "npm" && args[0] === "install" && args.includes("--prefix")) {
          // Create fake downloaded package structure
          const prefix = args[args.indexOf("--prefix") + 1];
          const pkgDir = path.join(prefix, "node_modules", "supipowers");
          fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
          fs.writeFileSync(path.join(pkgDir, "src", "index.ts"), "export default function() {}");
          fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: "2.0.0" }));
          return { stdout: "", stderr: "", code: 0 };
        }

        // bun install → success
        if (cmd === "bun" && args[0] === "install") {
          return { stdout: "", stderr: "", code: 0 };
        }

        return { stdout: "", stderr: "", code: 0 };
      }),
    });

    const ctx = createMockContext({
      ui: {
        select: mock(async () => "Update supipowers only"),
        notify: mock(),
        input: mock(async () => null),
      },
    });

    handleUpdate(platform, ctx);
    // handleUpdate is void-returning with an internal async IIFE; wait for it
    await new Promise((r) => setTimeout(r, 200));

    // Verify bun install was called in the extension directory
    const bunInstallCall = execCalls.find(
      (c) => c.cmd === "bun" && c.args[0] === "install",
    );
    expect(bunInstallCall).toBeDefined();
    expect(bunInstallCall!.opts?.cwd ?? bunInstallCall!.args).toBeDefined();
    // The cwd should be the extension directory
    expect(bunInstallCall!.opts?.cwd).toBe(extDir);
  });

  test("falls back to npm install when bun install fails", async () => {
    const execCalls: Array<{ cmd: string; args: string[]; opts?: any }> = [];

    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );

    const platform = createMockPlatform({
      paths: {
        dotDir: ".omp",
        dotDirDisplay: ".omp",
        project: (cwd: string, ...s: string[]) => path.join(cwd, ".omp", "supipowers", ...s),
        global: (...s: string[]) => path.join(tmpDir, "global", ...s),
        agent: (...s: string[]) => path.join(tmpDir, "agent", ...s),
      },
      exec: mock(async (cmd: string, args: string[], opts?: any) => {
        execCalls.push({ cmd, args, opts });

        if (cmd === "npm" && args[0] === "view") {
          return { stdout: "2.0.0\n", stderr: "", code: 0 };
        }

        if (cmd === "npm" && args[0] === "install" && args.includes("--prefix")) {
          const prefix = args[args.indexOf("--prefix") + 1];
          const pkgDir = path.join(prefix, "node_modules", "supipowers");
          fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
          fs.writeFileSync(path.join(pkgDir, "src", "index.ts"), "export default function() {}");
          fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: "2.0.0" }));
          return { stdout: "", stderr: "", code: 0 };
        }

        // bun install → FAIL
        if (cmd === "bun" && args[0] === "install") {
          return { stdout: "", stderr: "bun not found", code: 1 };
        }

        // npm install (fallback) → success
        if (cmd === "npm" && args[0] === "install" && args.includes("--omit=dev")) {
          return { stdout: "", stderr: "", code: 0 };
        }

        return { stdout: "", stderr: "", code: 0 };
      }),
    });

    const ctx = createMockContext({
      ui: {
        select: mock(async () => "Update supipowers only"),
        notify: mock(),
        input: mock(async () => null),
      },
    });

    handleUpdate(platform, ctx);
    await new Promise((r) => setTimeout(r, 200));

    // bun install was attempted and failed
    const bunCall = execCalls.find((c) => c.cmd === "bun" && c.args[0] === "install");
    expect(bunCall).toBeDefined();

    // npm install fallback was called
    const npmFallback = execCalls.find(
      (c) => c.cmd === "npm" && c.args.includes("--omit=dev"),
    );
    expect(npmFallback).toBeDefined();
    expect(npmFallback!.opts?.cwd).toBe(extDir);
  });
});

describe("handleUpdate — MemPalace prompt", () => {
  let tmpDir: string;
  let extDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-update-mem-"));
    extDir = path.join(tmpDir, "agent", "extensions", "supipowers");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function platformWithExec(execImpl: (cmd: string, args: string[], opts?: any) => Promise<any>) {
    return createMockPlatform({
      paths: {
        dotDir: ".omp",
        dotDirDisplay: ".omp",
        project: (cwd: string, ...s: string[]) => path.join(cwd, ".omp", "supipowers", ...s),
        global: (...s: string[]) => path.join(tmpDir, "global", ".omp", "supipowers", ...s),
        agent: (...s: string[]) => path.join(tmpDir, "agent", ...s),
      },
      exec: mock(execImpl),
    });
  }

  function selectByPrompt(answers: Record<string, string>) {
    return mock(async (title: string) => {
      for (const [match, value] of Object.entries(answers)) {
        if (title.includes(match)) return value;
      }
      return null;
    });
  }

  test("does not run MemPalace setup when the user picks Skip", async () => {
    const execCalls: Array<{ cmd: string; args: string[] }> = [];
    const platform = platformWithExec(async (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === "npm" && args[0] === "view") return { stdout: "2.0.0\n", stderr: "", code: 0 };
      if (cmd === "npm" && args.includes("--prefix")) {
        const prefix = args[args.indexOf("--prefix") + 1];
        const pkgDir = path.join(prefix, "node_modules", "supipowers");
        fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
        fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: "2.0.0" }));
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const ctx = createMockContext({
      cwd: tmpDir,
      ui: {
        select: selectByPrompt({
          "Update supipowers": "Update supipowers only",
          "MemPalace memory": "Skip",
        }),
        notify: mock(),
        input: mock(async () => null),
      },
    });

    handleUpdate(platform, ctx);
    await new Promise((r) => setTimeout(r, 250));

    const uvCall = execCalls.find((c) => c.args.includes("venv") || c.args.includes("install") && c.args.some((a) => a.startsWith("mempalace==")));
    expect(uvCall).toBeUndefined();
  });

  test("runs MemPalace setup through platform.exec when the user picks Yes", async () => {
    // Pre-stage a managed uv binary so ensureUv hits the cached path.
    const binDir = path.join(tmpDir, "global", ".omp", "supipowers", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const uvPlatform = detectUvPlatform();
    if (!uvPlatform) throw new Error("unsupported test platform");
    const uvPath = path.join(binDir, uvTargetFor(uvPlatform).binary);
    fs.writeFileSync(uvPath, "");
    if (process.platform !== "win32") fs.chmodSync(uvPath, 0o755);
    fs.writeFileSync(path.join(binDir, "uv.version"), "0.5.30\n");
    // Pin the managed venv to a tmp path via project config so we never touch ~/.omp.
    const venvRoot = path.join(tmpDir, "mempalace-venv");
    const projectConfigDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, "config.json"),
      JSON.stringify({ mempalace: { managedVenvPath: venvRoot } }),
    );
    const venv = resolveManagedVenvPaths(venvRoot);

    const execCalls: Array<{ cmd: string; args: string[] }> = [];
    const platform = platformWithExec(async (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === "npm" && args[0] === "view") return { stdout: "2.0.0\n", stderr: "", code: 0 };
      if (cmd === "npm" && args.includes("--prefix")) {
        const prefix = args[args.indexOf("--prefix") + 1];
        const pkgDir = path.join(prefix, "node_modules", "supipowers");
        fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
        fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: "2.0.0" }));
        return { stdout: "", stderr: "", code: 0 };
      }
      if (cmd === uvPath && args[0] === "venv") {
        fs.mkdirSync(path.dirname(venv.python), { recursive: true });
        fs.writeFileSync(venv.python, "");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (cmd === uvPath) return { stdout: "", stderr: "", code: 0 };
      // Bridge subprocess invocations
      return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: "", code: 0 };
    });

    const notify = mock();
    const ctx = createMockContext({
      cwd: tmpDir,
      ui: {
        select: selectByPrompt({
          "Update supipowers": "Update supipowers only",
          "MemPalace memory": "Yes",
        }),
        notify,
        input: mock(async () => null),
      },
    });

    try {
      handleUpdate(platform, ctx);
      await new Promise((r) => setTimeout(r, 400));

      const venvCall = execCalls.find((c) => c.cmd === uvPath && c.args[0] === "venv");
      expect(venvCall).toBeDefined();
      const pipCall = execCalls.find(
        (c) => c.cmd === uvPath && c.args[0] === "pip" && c.args.some((a) => a.startsWith("mempalace==")),
      );
      expect(pipCall).toBeDefined();
      const messages = (notify.mock.calls as any[]).map((call) => call[0] as string);
      expect(messages.some((m) => m.includes(`MemPalace v${MEMPALACE_PACKAGE_VERSION} ready`))).toBe(true);
    } finally {
      // venvRoot is inside tmpDir; afterEach handles cleanup.
    }
  });
});