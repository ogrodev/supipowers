import { describe, expect, it, test, mock, beforeEach, afterEach } from "bun:test";
import { buildUpdateOptions, handleUpdate } from "../../src/commands/update.js";
import { createMockPlatform, createMockContext } from "../../src/platform/test-utils.js";
import type { DependencyStatus } from "../../src/deps/registry.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
function makeDep(overrides: Partial<DependencyStatus> = {}): DependencyStatus {
  return {
    name: "test-tool",
    binary: "test-tool",
    required: false,
    category: "mcp",
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
      makeDep({ name: "mcpc", installCmd: "npm install -g @apify/mcpc" }),
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
      makeDep({ name: "mcpc", installCmd: "npm install -g @apify/mcpc" }), // has installCmd
    ];

    const options = buildUpdateOptions(missing);

    // Only mcpc has installCmd, so count should be 1
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