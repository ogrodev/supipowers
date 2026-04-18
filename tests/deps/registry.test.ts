import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  DEPENDENCIES,
  scanAll,
  scanMissing,
  installDep,
  installAll,
  formatReport,
  checkBinary,
  type ExecFn,
  type DependencyStatus,
} from "../../src/deps/registry.js";

// ── Bun.which mock ───────────────────────────────────────
// checkBinary uses Bun.which() for cross-platform binary lookup.
// Tests must mock it so results are deterministic.

let bunWhichSpy: ReturnType<typeof spyOn>;
let bunWhichResults: Record<string, string | null>;

beforeEach(() => {
  bunWhichResults = {};
  bunWhichSpy = spyOn(Bun, "which");
  bunWhichSpy.mockImplementation((binary: string) => {
    return bunWhichResults[binary] ?? null;
  });
});

afterEach(() => {
  bunWhichSpy.mockRestore();
});

/** Configure Bun.which to find the given binaries. */
function setBinariesFound(binaries: string[]): void {
  for (const b of binaries) {
    bunWhichResults[b] = `/usr/bin/${b}`;
  }
}

// ── Mock exec ─────────────────────────────────────────────

function createMockExec(
  versionOutput = "1.0.0",
): ExecFn {
  return async (cmd: string, args: string[]) => {
    // Handle npx <binary> --version (playwright uses this pattern)
    if (cmd === "npx" && args.length >= 2 && args[1] === "--version") {
      return { stdout: versionOutput, stderr: "", code: 0 };
    }
    if (args[0] === "--version") {
      return { stdout: versionOutput, stderr: "", code: 0 };
    }
    // Default: install commands succeed
    return { stdout: "", stderr: "", code: 0 };
  };
}

// ── DEPENDENCIES shape ────────────────────────────────────

describe("DEPENDENCIES", () => {
  it("is non-empty", () => {
    expect(DEPENDENCIES.length).toBeGreaterThan(0);
  });

  it("every entry has all required fields", () => {
    for (const dep of DEPENDENCIES) {
      expect(dep).toHaveProperty("name");
      expect(dep).toHaveProperty("binary");
      expect(dep).toHaveProperty("required");
      expect(dep).toHaveProperty("category");
      expect(dep).toHaveProperty("description");
      expect(dep).toHaveProperty("checkFn");
      expect(dep).toHaveProperty("installCmd");
      expect(dep).toHaveProperty("url");
      expect(typeof dep.name).toBe("string");
      expect(typeof dep.binary).toBe("string");
      expect(typeof dep.required).toBe("boolean");
      expect(["core", "mcp", "lsp", "testing"]).toContain(dep.category);
      expect(typeof dep.checkFn).toBe("function");
    }
  });

  it("contains the expected dependency names", () => {
    const names = DEPENDENCIES.map((d) => d.name);
    expect(names).toContain("Git");
    expect(names).toContain("mcpc");
    expect(names).toContain("TypeScript LSP");
    expect(names).toContain("playwright-cli");
    expect(names).toContain("Playwright Test");
  });

  it("playwright-cli entry has correct shape", () => {
    const pw = DEPENDENCIES.find((d) => d.name === "playwright-cli");
    expect(pw).toBeDefined();
    expect(pw!.binary).toBe("playwright-cli");
    expect(pw!.required).toBe(false);
    expect(pw!.category).toBe("testing");
    expect(pw!.description).toBe("Browser automation CLI for E2E testing");
    expect(pw!.installCmd).toBe("npm install -g @playwright/cli@latest");
    expect(pw!.url).toBe("https://github.com/microsoft/playwright-cli");
  });

  it("Playwright Test entry has correct shape", () => {
    const pw = DEPENDENCIES.find((d) => d.name === "Playwright Test");
    expect(pw).toBeDefined();
    expect(pw!.binary).toBe("playwright");
    expect(pw!.required).toBe(false);
    expect(pw!.category).toBe("testing");
    expect(pw!.description).toContain("portable QA Bun entrypoints");
    expect(pw!.installCmd).toBeNull();
    expect(pw!.url).toBe("https://playwright.dev");
  });
});

// ── checkBinary ───────────────────────────────────────────

describe("checkBinary", () => {
  it("returns installed: true with version when Bun.which finds binary", async () => {
    setBinariesFound(["git"]);
    const exec = createMockExec("git version 2.43.0");
    const result = await checkBinary(exec, "git");
    expect(result.installed).toBe(true);
    expect(result.version).toBe("git version 2.43.0");
  });

  it("returns installed: false when Bun.which returns null", async () => {
    // bunWhichResults is empty by default — no binaries found
    const exec = createMockExec();
    const result = await checkBinary(exec, "git");
    expect(result.installed).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it("does not call exec for lookup — uses Bun.which instead", async () => {
    setBinariesFound(["git"]);
    const calledCmds: string[] = [];
    const exec: ExecFn = async (cmd, _args) => {
      calledCmds.push(cmd);
      return { stdout: "1.0.0", stderr: "", code: 0 };
    };
    await checkBinary(exec, "git");
    // exec should only be called for --version, never for which/where
    expect(calledCmds).toEqual(["git"]);
    expect(bunWhichSpy).toHaveBeenCalledWith("git");
  });
});

// ── scanAll ───────────────────────────────────────────────

describe("scanAll", () => {
  it("marks deps as installed when Bun.which finds all binaries", async () => {
    // Make Bun.which find every dependency's binary
    setBinariesFound(DEPENDENCIES.map((d) => d.binary));
    const exec = createMockExec();
    const statuses = await scanAll(exec);

    // All binary-checked deps should be installed (bun:sqlite uses its own check)
    for (const s of statuses) {
      if (s.binary !== "__bun_sqlite__") {
        expect(s.installed).toBe(true);
      }
    }
  });

  it("marks deps as not installed when Bun.which returns null", async () => {
    // bunWhichResults is empty by default — no binaries found
    const exec = createMockExec();
    const statuses = await scanAll(exec);

    for (const s of statuses) {
      // __bun_sqlite__ uses built-in check; context-mode uses filesystem detection (not exec)
      if (s.binary !== "__bun_sqlite__" && s.binary !== "context-mode") {
        expect(s.installed).toBe(false);
      }
    }
  });

  it("returns correct number of statuses", async () => {
    const exec = createMockExec();
    const statuses = await scanAll(exec);
    expect(statuses.length).toBe(DEPENDENCIES.length);
  });

  it("each status has required fields", async () => {
    const exec = createMockExec();
    const statuses = await scanAll(exec);
    for (const s of statuses) {
      expect(s).toHaveProperty("name");
      expect(s).toHaveProperty("binary");
      expect(s).toHaveProperty("required");
      expect(s).toHaveProperty("category");
      expect(s).toHaveProperty("installed");
    }
  });
});

// ── scanMissing ───────────────────────────────────────────

describe("scanMissing", () => {
  it("returns only deps that are not installed", async () => {
    setBinariesFound(["git"]); // only git is findable
    const exec = createMockExec();
    const missing = await scanMissing(exec);

    const names = missing.map((m) => m.name);
    expect(names).not.toContain("Git");
    // mcpc is not in Bun.which results so should be missing
    expect(names).toContain("mcpc");
  });
});

// ── installDep ────────────────────────────────────────────

describe("installDep", () => {
  it("runs install command and returns success", async () => {
    const exec = createMockExec();
    const result = await installDep(exec, "mcpc");
    expect(result.success).toBe(true);
    expect(result.name).toBe("mcpc");
  });

  it("returns error for unknown dependency", async () => {
    const exec = createMockExec();
    const result = await installDep(exec, "nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown dependency");
  });

  it("returns error when dep has no install command", async () => {
    const exec = createMockExec();
    const result = await installDep(exec, "Git");
    expect(result.success).toBe(false);
    expect(result.error).toContain("No install command");
  });

  it("returns error when install command fails", async () => {
    const exec: ExecFn = async () => ({
      stdout: "",
      stderr: "permission denied",
      code: 1,
    });
    const result = await installDep(exec, "mcpc");
    expect(result.success).toBe(false);
    expect(result.error).toBe("permission denied");
  });
});

// ── installAll ────────────────────────────────────────────

describe("installAll", () => {
  it("skips deps with null installCmd", async () => {
    const exec = createMockExec();
    const deps: DependencyStatus[] = [
      {
        name: "Git",
        binary: "git",
        required: true,
        category: "core",
        description: "VCS",
        installCmd: null,
        url: "https://git-scm.com",
        installed: false,
      },
      {
        name: "mcpc",
        binary: "mcpc",
        required: false,
        category: "mcp",
        description: "MCP CLI",
        installCmd: "npm install -g @apify/mcpc",
        url: "https://github.com/apify/mcpc",
        installed: false,
      },
    ];
    const results = await installAll(exec, deps);
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("mcpc");
  });

  it("returns empty array when no installable deps", async () => {
    const exec = createMockExec();
    const deps: DependencyStatus[] = [
      {
        name: "Git",
        binary: "git",
        required: true,
        category: "core",
        description: "VCS",
        installCmd: null,
        url: "https://git-scm.com",
        installed: false,
      },
    ];
    const results = await installAll(exec, deps);
    expect(results.length).toBe(0);
  });

  it("does not include result entries for null installCmd deps", async () => {
    const exec = createMockExec();
    const deps: DependencyStatus[] = [
      {
        name: "Git",
        binary: "git",
        required: true,
        category: "core",
        description: "VCS",
        installCmd: null,
        url: "https://git-scm.com",
        installed: false,
      },
      {
        name: "mcpc",
        binary: "mcpc",
        required: false,
        category: "mcp",
        description: "MCP CLI",
        installCmd: "npm install -g @apify/mcpc",
        url: "https://github.com/apify/mcpc",
        installed: false,
      },
    ];
    const results = await installAll(exec, deps);
    // null installCmd entries are silently skipped — no result entry produced
    const names = results.map((r) => r.name);
    expect(names).not.toContain("Git");
    expect(names).toContain("mcpc");
  });
});

// ── formatReport ──────────────────────────────────────────

describe("formatReport", () => {
  it("shows installed dep with version string", () => {
    const statuses: DependencyStatus[] = [
      {
        name: "Git",
        binary: "git",
        required: true,
        category: "core",
        description: "VCS",
        installCmd: null,
        url: "https://git-scm.com",
        installed: true,
        version: "git version 2.43.0",
      },
    ];
    const report = formatReport(statuses);
    expect(report).toContain("✓ Git");
    expect(report).toContain("git version 2.43.0");
  });

  it("shows missing dep with manual install URL", () => {
    const statuses: DependencyStatus[] = [
      {
        name: "mcpc",
        binary: "mcpc",
        required: false,
        category: "mcp",
        description: "MCP CLI",
        installCmd: "npm install -g @apify/mcpc",
        url: "https://github.com/apify/mcpc",
        installed: false,
      },
    ];
    const report = formatReport(statuses);
    expect(report).toContain("✗ mcpc");
    expect(report).toContain("npm install -g @apify/mcpc");
  });

  it("groups by category and shows status icons", () => {
    const statuses: DependencyStatus[] = [
      {
        name: "Git",
        binary: "git",
        required: true,
        category: "core",
        description: "VCS",
        installCmd: null,
        url: "https://git-scm.com",
        installed: true,
        version: "2.43.0",
      },
      {
        name: "mcpc",
        binary: "mcpc",
        required: false,
        category: "mcp",
        description: "MCP CLI",
        installCmd: "npm install -g @apify/mcpc",
        url: "https://github.com/apify/mcpc",
        installed: false,
      },
    ];
    const report = formatReport(statuses);
    expect(report).toContain("✓ Git");
    expect(report).toContain("2.43.0");
    expect(report).toContain("✗ mcpc");
    expect(report).toContain("npm install -g @apify/mcpc");
    expect(report).toContain("Core");
    expect(report).toContain("MCP");
  });

  it("shows install results when provided", () => {
    const statuses: DependencyStatus[] = [
      {
        name: "mcpc",
        binary: "mcpc",
        required: false,
        category: "mcp",
        description: "MCP CLI",
        installCmd: "npm install -g @apify/mcpc",
        url: "https://github.com/apify/mcpc",
        installed: false,
      },
    ];
    const installResults = [{ name: "mcpc", success: true }];
    const report = formatReport(statuses, installResults);
    expect(report).toContain("→ installed");
  });

  it("shows install failure when provided", () => {
    const statuses: DependencyStatus[] = [
      {
        name: "mcpc",
        binary: "mcpc",
        required: false,
        category: "mcp",
        description: "MCP CLI",
        installCmd: "npm install -g @apify/mcpc",
        url: "https://github.com/apify/mcpc",
        installed: false,
      },
    ];
    const installResults = [
      { name: "mcpc", success: false, error: "permission denied" },
    ];
    const report = formatReport(statuses, installResults);
    expect(report).toContain("→ failed: permission denied");
  });

  it("renders testing category", () => {
    const statuses: DependencyStatus[] = [
      {
        name: "playwright-cli",
        binary: "playwright-cli",
        required: false,
        category: "testing",
        description: "Browser automation CLI for E2E testing",
        installCmd: "npm install -g @playwright/cli@latest",
        url: "https://github.com/microsoft/playwright-cli",
        installed: true,
        version: "1.50.0",
      },
    ];
    const report = formatReport(statuses);
    expect(report).toContain("Testing");
    expect(report).toContain("✓ playwright-cli");
    expect(report).toContain("1.50.0");
  });
});
