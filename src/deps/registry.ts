// src/deps/registry.ts — Dependency registry: scan, install, report

import type { ExecResult } from "../platform/types.js";

// ── Types ─────────────────────────────────────────────────

export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface Dependency {
  name: string;
  binary: string;
  required: boolean;
  category: "core" | "mcp" | "lsp" | "testing";
  description: string;
  checkFn: (exec: ExecFn) => Promise<{ installed: boolean; version?: string }>;
  installCmd: string | null;
  url: string;
}

export interface DependencyStatus extends Omit<Dependency, "checkFn"> {
  installed: boolean;
  version?: string;
}

export interface InstallResult {
  name: string;
  success: boolean;
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────

export async function checkBinary(
  exec: ExecFn,
  binary: string,
): Promise<{ installed: boolean; version?: string }> {
  // Bun.which() is cross-platform (handles .cmd/.exe/.bat on Windows)
  // and doesn't require shelling out to `which` (Unix) or `where` (Windows).
  const found = Bun.which(binary);
  if (!found) return { installed: false };

  const ver = await exec(binary, ["--version"]);
  const version = ver.code === 0 ? ver.stdout.trim().split("\n")[0] : undefined;
  return { installed: true, version };
}

export function checkBunSqlite(): { installed: boolean; version?: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");
    // Verify FTS5 is available
    db.exec(
      "CREATE VIRTUAL TABLE _fts5_test USING fts5(content); DROP TABLE _fts5_test;",
    );
    db.close();
    return { installed: true, version: "built-in" };
  } catch {
    return { installed: false };
  }
}

// ── Registry ──────────────────────────────────────────────

export const DEPENDENCIES: Dependency[] = [
  {
    name: "Git",
    binary: "git",
    required: true,
    category: "core",
    description: "Version control system",
    checkFn: (exec) => checkBinary(exec, "git"),
    installCmd: null,
    url: "https://git-scm.com",
  },
  {
    name: "bun:sqlite + FTS5",
    binary: "__bun_sqlite__",
    required: true,
    category: "core",
    description: "Bun built-in SQLite with FTS5 full-text search",
    checkFn: () => Promise.resolve(checkBunSqlite()),
    installCmd: null,
    url: "https://bun.sh",
  },
  {
    name: "mcpc",
    binary: "mcpc",
    required: false,
    category: "mcp",
    description: "MCP client CLI for server management",
    checkFn: (exec) => checkBinary(exec, "mcpc"),
    installCmd: "npm install -g @apify/mcpc",
    url: "https://github.com/apify/mcpc",
  },
  {
    name: "supi-context-mode",
    binary: "context-mode",
    required: false,
    category: "mcp",
    description: "supi-context-mode MCP server for context window protection",
    checkFn: async (_exec) => {
      // supi-context-mode is installed as a platform extension (git clone), not globally.
      // start.mjs lives at the repo root after cloning.
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const home = homedir();
      const startMjs = join(home, ".omp", "extensions", "context-mode", "start.mjs");
      if (existsSync(startMjs)) return { installed: true, version: "extension" };
      return { installed: false };
    },
    installCmd: null, // Handled by installer (git clone + npm install + npm run build)
    url: "https://github.com/mksglu/context-mode",
  },
  {
    name: "TypeScript LSP",
    binary: "typescript-language-server",
    required: false,
    category: "lsp",
    description: "Language server for TypeScript and JavaScript",
    checkFn: (exec) => checkBinary(exec, "typescript-language-server"),
    installCmd: "bun add -g typescript-language-server typescript",
    url: "https://github.com/typescript-language-server/typescript-language-server",
  },
  {
    name: "Pyright",
    binary: "pyright",
    required: false,
    category: "lsp",
    description: "Static type checker and language server for Python",
    checkFn: (exec) => checkBinary(exec, "pyright"),
    installCmd: "pip install pyright",
    url: "https://github.com/microsoft/pyright",
  },
  {
    name: "rust-analyzer",
    binary: "rust-analyzer",
    required: false,
    category: "lsp",
    description: "Language server for Rust",
    checkFn: (exec) => checkBinary(exec, "rust-analyzer"),
    installCmd: "rustup component add rust-analyzer",
    url: "https://rust-analyzer.github.io",
  },
  {
    name: "gopls",
    binary: "gopls",
    required: false,
    category: "lsp",
    description: "Language server for Go",
    checkFn: (exec) => checkBinary(exec, "gopls"),
    installCmd: "go install golang.org/x/tools/gopls@latest",
    url: "https://pkg.go.dev/golang.org/x/tools/gopls",
  },
  {
    name: "playwright-cli",
    binary: "playwright-cli",
    required: false,
    category: "testing",
    description: "Browser automation CLI for E2E testing",
    checkFn: (exec) => checkBinary(exec, "playwright-cli"),
    installCmd: "npm install -g @playwright/cli@latest",
    url: "https://github.com/microsoft/playwright-cli",
  },
  {
    name: "Playwright Test",
    binary: "playwright",
    required: false,
    category: "testing",
    description: "Test runner for E2E tests (run-e2e-tests.sh)",
    checkFn: (exec) => checkBinary(exec, "playwright"),
    installCmd: null, // Compound command (&&) — not compatible with installDep's naive split
    url: "https://playwright.dev",
  },
];

// ── Scan ──────────────────────────────────────────────────

export async function scanAll(exec: ExecFn): Promise<DependencyStatus[]> {
  const results = await Promise.all(
    DEPENDENCIES.map(async (dep) => {
      const check = await dep.checkFn(exec);
      return {
        name: dep.name,
        binary: dep.binary,
        required: dep.required,
        category: dep.category,
        description: dep.description,
        installCmd: dep.installCmd,
        url: dep.url,
        installed: check.installed,
        version: check.version,
      };
    }),
  );
  return results;
}

export async function scanMissing(exec: ExecFn): Promise<DependencyStatus[]> {
  const all = await scanAll(exec);
  return all.filter((s) => !s.installed);
}

// ── Install ───────────────────────────────────────────────

export async function installDep(
  exec: ExecFn,
  name: string,
): Promise<InstallResult> {
  const dep = DEPENDENCIES.find((d) => d.name === name);
  if (!dep) return { name, success: false, error: `Unknown dependency: ${name}` };
  if (!dep.installCmd)
    return { name, success: false, error: "No install command available" };

  // Split is safe for current commands (no quoted args). If future commands
  // need complex args, change installCmd to { cmd: string; args: string[] }.
  const parts = dep.installCmd.split(" ");
  const cmd = parts[0];
  const args = parts.slice(1);

  try {
    const result = await exec(cmd, args);
    if (result.code !== 0) {
      return {
        name,
        success: false,
        error: result.stderr.trim() || `Exit code ${result.code}`,
      };
    }
    return { name, success: true };
  } catch (err) {
    return {
      name,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function installAll(
  exec: ExecFn,
  deps: DependencyStatus[],
): Promise<InstallResult[]> {
  // Sequential to avoid package manager conflicts (e.g., concurrent npm installs)
  const results: InstallResult[] = [];
  for (const dep of deps) {
    if (!dep.installCmd) continue;
    results.push(await installDep(exec, dep.name));
  }
  return results;
}

// ── Report ────────────────────────────────────────────────

export function formatReport(
  statuses: DependencyStatus[],
  installResults?: InstallResult[],
): string {
  const lines: string[] = [];
  const installMap = new Map(installResults?.map((r) => [r.name, r]));

  // Report renders categories in insertion order of this object.
  // Object.keys preserves insertion order for string keys in all major engines (V8/JSC/SM).
  const categoryLabels: Record<Dependency["category"], string> = {
    core: "Core",
    mcp: "MCP",
    lsp: "Language Servers",
    testing: "Testing",
  };

  for (const cat of Object.keys(categoryLabels) as Dependency["category"][]) {
    const group = statuses.filter((s) => s.category === cat);
    if (group.length === 0) continue;

    lines.push(`\n  ${categoryLabels[cat]}`);
    lines.push("  " + "─".repeat(40));

    for (const s of group) {
      const icon = s.installed ? "✓" : "✗";
      const ver = s.version ? ` (${s.version})` : "";
      let line = `  ${icon} ${s.name}${ver}`;

      const ir = installMap.get(s.name);
      if (ir) {
        line += ir.success ? " → installed" : ` → failed: ${ir.error}`;
      } else if (!s.installed && s.installCmd) {
        line += ` — install: ${s.installCmd}`;
      }

      lines.push(line);
    }
  }

  return lines.join("\n");
}
