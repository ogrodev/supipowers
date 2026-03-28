# Dependency Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified dependency registry that verifies and installs external tools at both CLI install (bunx) and `/supi:update` time.

**Architecture:** A single TypeScript module (`src/deps/registry.ts`) defines all external dependencies with check/install functions. Two consumers — the CLI installer (`bin/install.ts`) and the OMP TUI command (`src/commands/update.ts`) — import the same registry. Both present interactive UIs and produce CLI reports for anything that can't be auto-installed.

**Tech Stack:** TypeScript, `@clack/prompts` (CLI), OMP `ctx.ui` (TUI), `spawnSync`/`platform.exec` for checks.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/deps/registry.ts` | **New** — dependency definitions, scan, install, report formatting |
| `tests/deps/registry.test.ts` | **New** — unit tests for registry with mocked exec |
| `src/commands/update.ts` | **Rewrite** — TUI command using registry for scan/install/report |
| `tests/commands/update.test.ts` | **New** — unit tests for the update command logic |
| `bin/install.ts` | **New** — TypeScript rewrite of install.mjs, imports registry |
| `bin/install.mjs` | **Rewrite** — thin shim that runs `bun bin/install.ts` |

---

### Task 1: Create the Dependency Registry — Types and Definitions

**Files:**
- Create: `src/deps/registry.ts`
- Create: `tests/deps/registry.test.ts`

- [ ] **Step 1: Write the failing test for scanAll**

```typescript
// tests/deps/registry.test.ts
import { describe, it, expect, vi } from "vitest";
import { scanAll, DEPENDENCIES } from "../../src/deps/registry.js";
import type { ExecResult } from "../../src/platform/types.js";

function mockExec(responses: Record<string, Partial<ExecResult>>) {
  return vi.fn(async (cmd: string, args: string[]): Promise<ExecResult> => {
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pattern, result] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        return { stdout: "", stderr: "", code: 0, ...result };
      }
    }
    return { stdout: "", stderr: "", code: 1 };
  });
}

describe("registry", () => {
  it("exports a non-empty DEPENDENCIES list", () => {
    expect(DEPENDENCIES.length).toBeGreaterThan(0);
    for (const dep of DEPENDENCIES) {
      expect(dep.name).toBeTruthy();
      expect(dep.category).toMatch(/^(core|mcp|lsp)$/);
      expect(dep.url).toBeTruthy();
    }
  });

  describe("scanAll", () => {
    it("marks deps as installed when check succeeds", async () => {
      const exec = mockExec({
        "which git": { stdout: "/usr/bin/git\n", code: 0 },
        "git --version": { stdout: "git version 2.43.0\n", code: 0 },
        "which mcpc": { stdout: "/usr/local/bin/mcpc\n", code: 0 },
        "mcpc --version": { stdout: "mcpc 1.2.0\n", code: 0 },
        "which context-mode": { stdout: "", code: 1 },
        "which typescript-language-server": { stdout: "", code: 1 },
        "which pyright": { stdout: "", code: 1 },
        "which rust-analyzer": { stdout: "", code: 1 },
        "which gopls": { stdout: "", code: 1 },
      });
      const results = await scanAll(exec);
      const git = results.find((d) => d.name === "Git");
      expect(git?.installed).toBe(true);
      expect(git?.version).toContain("2.43");

      const mcpc = results.find((d) => d.name === "mcpc");
      expect(mcpc?.installed).toBe(true);

      const ctxMode = results.find((d) => d.name === "context-mode");
      expect(ctxMode?.installed).toBe(false);
    });

    it("marks deps as not installed when check fails", async () => {
      const exec = mockExec({}); // everything returns code 1
      const results = await scanAll(exec);
      for (const dep of results) {
        // bun:sqlite check doesn't use exec — skip it
        if (dep.binary === "__bun_sqlite__") continue;
        expect(dep.installed).toBe(false);
      }
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/deps/registry.test.ts`
Expected: FAIL — cannot resolve `../../src/deps/registry.js`

- [ ] **Step 3: Write the registry module**

```typescript
// src/deps/registry.ts
import type { ExecResult } from "../platform/types.js";

type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface Dependency {
  name: string;
  binary: string;
  required: boolean;
  category: "core" | "mcp" | "lsp";
  description: string;
  checkFn: (exec: ExecFn) => Promise<{ installed: boolean; version?: string }>;
  installCmd: string | null;
  url: string;
}

export interface DependencyStatus {
  name: string;
  binary: string;
  required: boolean;
  category: "core" | "mcp" | "lsp";
  description: string;
  installCmd: string | null;
  url: string;
  installed: boolean;
  version?: string;
}

export interface InstallResult {
  name: string;
  success: boolean;
  error?: string;
}

async function checkBinary(exec: ExecFn, binary: string): Promise<{ installed: boolean; version?: string }> {
  try {
    const which = await exec("which", [binary]);
    if (which.code !== 0) return { installed: false };
    const ver = await exec(binary, ["--version"]);
    const version = ver.code === 0 ? ver.stdout.trim().split("\n")[0] : undefined;
    return { installed: true, version };
  } catch {
    return { installed: false };
  }
}

function checkBunSqlite(): { installed: boolean; version?: string } {
  try {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS fts_test USING fts5(content)");
    db.close();
    return { installed: true, version: "built-in" };
  } catch {
    return { installed: false };
  }
}

export const DEPENDENCIES: Dependency[] = [
  {
    name: "Git",
    binary: "git",
    required: true,
    category: "core",
    description: "Version control — required for worktrees, branch ops, and core workflows",
    checkFn: (exec) => checkBinary(exec, "git"),
    installCmd: null,
    url: "https://git-scm.com",
  },
  {
    name: "bun:sqlite + FTS5",
    binary: "__bun_sqlite__",
    required: true,
    category: "core",
    description: "SQLite with full-text search — required for EventStore (context-mode)",
    checkFn: async () => checkBunSqlite(),
    installCmd: null,
    url: "https://bun.sh",
  },
  {
    name: "mcpc",
    binary: "mcpc",
    required: false,
    category: "mcp",
    description: "MCP gateway CLI — connects to external MCP servers",
    checkFn: (exec) => checkBinary(exec, "mcpc"),
    installCmd: "npm install -g @apify/mcpc",
    url: "https://github.com/apify/mcpc",
  },
  {
    name: "context-mode",
    binary: "context-mode",
    required: false,
    category: "mcp",
    description: "Context window protection — keeps raw output in a sandbox",
    checkFn: (exec) => checkBinary(exec, "context-mode"),
    installCmd: "npm install -g context-mode",
    url: "https://github.com/context-mode/context-mode",
  },
  {
    name: "TypeScript LSP",
    binary: "typescript-language-server",
    required: false,
    category: "lsp",
    description: "TypeScript/JavaScript code intelligence",
    checkFn: (exec) => checkBinary(exec, "typescript-language-server"),
    installCmd: "bun add -g typescript-language-server typescript",
    url: "https://github.com/typescript-language-server/typescript-language-server",
  },
  {
    name: "Pyright",
    binary: "pyright",
    required: false,
    category: "lsp",
    description: "Python code intelligence",
    checkFn: (exec) => checkBinary(exec, "pyright"),
    installCmd: "pip install pyright",
    url: "https://github.com/microsoft/pyright",
  },
  {
    name: "rust-analyzer",
    binary: "rust-analyzer",
    required: false,
    category: "lsp",
    description: "Rust code intelligence",
    checkFn: (exec) => checkBinary(exec, "rust-analyzer"),
    installCmd: "rustup component add rust-analyzer",
    url: "https://rust-analyzer.github.io",
  },
  {
    name: "gopls",
    binary: "gopls",
    required: false,
    category: "lsp",
    description: "Go code intelligence",
    checkFn: (exec) => checkBinary(exec, "gopls"),
    installCmd: "go install golang.org/x/tools/gopls@latest",
    url: "https://pkg.go.dev/golang.org/x/tools/gopls",
  },
];

export async function scanAll(exec: ExecFn): Promise<DependencyStatus[]> {
  const results: DependencyStatus[] = [];
  for (const dep of DEPENDENCIES) {
    const { installed, version } = await dep.checkFn(exec);
    results.push({
      name: dep.name,
      binary: dep.binary,
      required: dep.required,
      category: dep.category,
      description: dep.description,
      installCmd: dep.installCmd,
      url: dep.url,
      installed,
      version,
    });
  }
  return results;
}

export async function scanMissing(exec: ExecFn): Promise<DependencyStatus[]> {
  const all = await scanAll(exec);
  return all.filter((d) => !d.installed);
}

export async function installDep(exec: ExecFn, name: string): Promise<InstallResult> {
  const dep = DEPENDENCIES.find((d) => d.name === name);
  if (!dep) return { name, success: false, error: `Unknown dependency: ${name}` };
  if (!dep.installCmd) return { name, success: false, error: `Cannot auto-install ${name} — install manually: ${dep.url}` };

  const [cmd, ...args] = dep.installCmd.split(" ");
  try {
    const result = await exec(cmd, args);
    if (result.code !== 0) {
      const stderr = result.stderr?.trim();
      return { name, success: false, error: stderr || `Install command exited with code ${result.code}` };
    }
    return { name, success: true };
  } catch (e) {
    return { name, success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function installAll(exec: ExecFn, deps: DependencyStatus[]): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  for (const dep of deps) {
    if (!dep.installCmd) {
      results.push({ name: dep.name, success: false, error: `Cannot auto-install — install manually: ${dep.url}` });
      continue;
    }
    results.push(await installDep(exec, dep.name));
  }
  return results;
}

export function formatReport(statuses: DependencyStatus[], installResults?: InstallResult[]): string {
  const lines: string[] = [];
  const installMap = new Map(installResults?.map((r) => [r.name, r]));

  for (const status of statuses) {
    const ir = installMap.get(status.name);
    if (ir?.success) {
      lines.push(`  ${status.name}: installed`);
    } else if (status.installed) {
      const ver = status.version ? ` (${status.version})` : "";
      lines.push(`  ${status.name}: already installed${ver}`);
    } else if (ir?.error) {
      lines.push(`  ${status.name}: FAILED — ${ir.error}`);
      if (status.installCmd) lines.push(`    Install manually: ${status.installCmd}`);
      lines.push(`    ${status.url}`);
    } else if (!status.installCmd) {
      lines.push(`  ${status.name}: MISSING — install manually`);
      lines.push(`    ${status.url}`);
    } else {
      lines.push(`  ${status.name}: SKIPPED — install manually: ${status.installCmd}`);
      lines.push(`    ${status.url}`);
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- tests/deps/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/deps/registry.ts tests/deps/registry.test.ts
git commit -m "feat(deps): add dependency registry with scan/install/report"
```

---

### Task 2: Add Registry Tests for installDep, installAll, and formatReport

**Files:**
- Modify: `tests/deps/registry.test.ts`

- [ ] **Step 1: Write failing tests for installDep**

Add to `tests/deps/registry.test.ts`:

```typescript
import { installDep, installAll, formatReport } from "../../src/deps/registry.js";
import type { DependencyStatus } from "../../src/deps/registry.js";

describe("installDep", () => {
  it("runs install command and returns success", async () => {
    const exec = mockExec({
      "npm install": { code: 0 },
    });
    const result = await installDep(exec, "mcpc");
    expect(result.success).toBe(true);
    expect(result.name).toBe("mcpc");
  });

  it("returns error for unknown dependency", async () => {
    const exec = mockExec({});
    const result = await installDep(exec, "nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown dependency");
  });

  it("returns error for deps without installCmd", async () => {
    const exec = mockExec({});
    const result = await installDep(exec, "Git");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot auto-install");
  });

  it("returns error when install command fails", async () => {
    const exec = mockExec({
      "npm install": { code: 1, stderr: "permission denied" },
    });
    const result = await installDep(exec, "mcpc");
    expect(result.success).toBe(false);
    expect(result.error).toContain("permission denied");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass** (implementation already exists from Task 1)

Run: `bun run test -- tests/deps/registry.test.ts`
Expected: PASS

- [ ] **Step 3: Write tests for installAll**

Add to `tests/deps/registry.test.ts`:

```typescript
describe("installAll", () => {
  it("installs only deps with installCmd", async () => {
    const exec = mockExec({
      "npm install": { code: 0 },
    });
    const deps: DependencyStatus[] = [
      { name: "Git", binary: "git", required: true, category: "core", description: "", installCmd: null, url: "https://git-scm.com", installed: false },
      { name: "mcpc", binary: "mcpc", required: false, category: "mcp", description: "", installCmd: "npm install -g @apify/mcpc", url: "https://github.com/apify/mcpc", installed: false },
    ];
    const results = await installAll(exec, deps);
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false); // Git can't auto-install
    expect(results[1].success).toBe(true);  // mcpc installed
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/deps/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Write tests for formatReport**

Add to `tests/deps/registry.test.ts`:

```typescript
describe("formatReport", () => {
  it("shows already installed deps with version", () => {
    const statuses: DependencyStatus[] = [
      { name: "Git", binary: "git", required: true, category: "core", description: "", installCmd: null, url: "https://git-scm.com", installed: true, version: "git version 2.43.0" },
    ];
    const report = formatReport(statuses);
    expect(report).toContain("Git: already installed (git version 2.43.0)");
  });

  it("shows missing deps with manual install URL", () => {
    const statuses: DependencyStatus[] = [
      { name: "Git", binary: "git", required: true, category: "core", description: "", installCmd: null, url: "https://git-scm.com", installed: false },
    ];
    const report = formatReport(statuses);
    expect(report).toContain("Git: MISSING");
    expect(report).toContain("https://git-scm.com");
  });

  it("shows successful installs", () => {
    const statuses: DependencyStatus[] = [
      { name: "mcpc", binary: "mcpc", required: false, category: "mcp", description: "", installCmd: "npm install -g @apify/mcpc", url: "https://github.com/apify/mcpc", installed: false },
    ];
    const results = [{ name: "mcpc", success: true }];
    const report = formatReport(statuses, results);
    expect(report).toContain("mcpc: installed");
  });

  it("shows failed installs with error and manual command", () => {
    const statuses: DependencyStatus[] = [
      { name: "mcpc", binary: "mcpc", required: false, category: "mcp", description: "", installCmd: "npm install -g @apify/mcpc", url: "https://github.com/apify/mcpc", installed: false },
    ];
    const results = [{ name: "mcpc", success: false, error: "EACCES" }];
    const report = formatReport(statuses, results);
    expect(report).toContain("mcpc: FAILED");
    expect(report).toContain("EACCES");
    expect(report).toContain("npm install -g @apify/mcpc");
  });
});
```

- [ ] **Step 6: Run all registry tests**

Run: `bun run test -- tests/deps/registry.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add tests/deps/registry.test.ts
git commit -m "test(deps): add tests for installDep, installAll, formatReport"
```

---

### Task 3: Rewrite `/supi:update` as TUI Command

**Files:**
- Modify: `src/commands/update.ts`
- Create: `tests/commands/update.test.ts`

- [ ] **Step 1: Write failing test for the update flow**

```typescript
// tests/commands/update.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildUpdateOptions, executeUpdate } from "../../src/commands/update.js";
import type { DependencyStatus } from "../../src/deps/registry.js";

describe("buildUpdateOptions", () => {
  it("returns 3 options when deps are missing", () => {
    const missing: DependencyStatus[] = [
      { name: "mcpc", binary: "mcpc", required: false, category: "mcp", description: "", installCmd: "npm install -g @apify/mcpc", url: "", installed: false },
    ];
    const options = buildUpdateOptions(missing);
    expect(options).toHaveLength(4); // 3 modes + Cancel
    expect(options[1]).toContain("1 missing");
  });

  it("shows (all installed) when nothing is missing", () => {
    const options = buildUpdateOptions([]);
    expect(options).toHaveLength(4);
    expect(options[1]).toContain("all installed");
  });
});

describe("executeUpdate", () => {
  it("copies files for supipowers-only mode", async () => {
    const exec = vi.fn(async () => ({ stdout: "1.1.0\n", stderr: "", code: 0 }));
    const notify = vi.fn();
    const result = await executeUpdate("supipowers-only", exec, notify, {
      agentDir: "/tmp/test-agent",
      currentVersion: "1.0.0",
    });
    expect(result.updated).toBe(true);
    expect(notify).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/commands/update.test.ts`
Expected: FAIL — cannot import `buildUpdateOptions` or `executeUpdate`

- [ ] **Step 3: Rewrite update.ts**

```typescript
// src/commands/update.ts
import type { Platform, PlatformContext } from "../platform/types.js";
import { scanAll, scanMissing, installAll, formatReport, DEPENDENCIES } from "../deps/registry.js";
import type { DependencyStatus } from "../deps/registry.js";
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function buildUpdateOptions(missing: DependencyStatus[]): string[] {
  const missingCount = missing.filter((d) => d.installCmd).length;
  const missingLabel = missingCount > 0 ? `(${missingCount} missing)` : "(all installed)";
  return [
    "Update supipowers only",
    `Update supipowers + install missing tools ${missingLabel}`,
    "Update supipowers + reinstall all tools (latest)",
    "Cancel",
  ];
}

async function updateSupipowers(
  platform: Platform,
  ctx: PlatformContext,
): Promise<{ updated: boolean; fromVersion: string; toVersion: string }> {
  const agentDir = platform.paths.agent();
  const extDir = join(agentDir, "extensions", "supipowers");
  const installedPkgPath = join(extDir, "package.json");

  let currentVersion = "unknown";
  if (existsSync(installedPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(installedPkgPath, "utf8"));
      currentVersion = pkg.version;
    } catch { /* corrupted */ }
  }

  const checkResult = await platform.exec("npm", ["view", "supipowers", "version"], { cwd: tmpdir() });
  if (checkResult.code !== 0) {
    ctx.ui.notify("Failed to check for updates — npm view failed", "error");
    return { updated: false, fromVersion: currentVersion, toVersion: currentVersion };
  }
  const latestVersion = checkResult.stdout.trim();

  if (latestVersion === currentVersion) {
    ctx.ui.notify(`supipowers v${currentVersion} is already up to date`, "info");
    return { updated: false, fromVersion: currentVersion, toVersion: currentVersion };
  }

  ctx.ui.notify(`Updating v${currentVersion} → v${latestVersion}...`, "info");

  const tempDir = join(tmpdir(), `supipowers-update-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    const installResult = await platform.exec(
      "npm", ["install", "--prefix", tempDir, `supipowers@${latestVersion}`],
      { cwd: tempDir },
    );
    if (installResult.code !== 0) {
      ctx.ui.notify("Failed to download latest version", "error");
      return { updated: false, fromVersion: currentVersion, toVersion: currentVersion };
    }

    const downloadedRoot = join(tempDir, "node_modules", "supipowers");
    if (!existsSync(downloadedRoot)) {
      ctx.ui.notify("Downloaded package not found", "error");
      return { updated: false, fromVersion: currentVersion, toVersion: currentVersion };
    }

    if (existsSync(extDir)) rmSync(extDir, { recursive: true });
    mkdirSync(extDir, { recursive: true });
    cpSync(join(downloadedRoot, "src"), join(extDir, "src"), { recursive: true });
    cpSync(join(downloadedRoot, "bin"), join(extDir, "bin"), { recursive: true });
    cpSync(join(downloadedRoot, "package.json"), join(extDir, "package.json"));

    const skillsSource = join(downloadedRoot, "skills");
    if (existsSync(skillsSource)) {
      for (const entry of readdirSync(skillsSource, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(skillsSource, entry.name, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        const destDir = join(agentDir, "skills", entry.name);
        mkdirSync(destDir, { recursive: true });
        cpSync(skillFile, join(destDir, "SKILL.md"));
      }
    }

    ctx.ui.notify(`supipowers updated to v${latestVersion}`, "info");
    return { updated: true, fromVersion: currentVersion, toVersion: latestVersion };
  } finally {
    try { rmSync(tempDir, { recursive: true }); } catch { /* best effort */ }
  }
}

export function handleUpdate(platform: Platform, ctx: PlatformContext): void {
  void (async () => {
    const exec = (cmd: string, args: string[]) => platform.exec(cmd, args);

    // Step 1: Scan deps
    const allStatuses = await scanAll(exec);
    const missing = allStatuses.filter((d) => !d.installed);

    // Step 2: Present options
    const options = buildUpdateOptions(missing);
    const choice = await ctx.ui.select("Supipowers Update", options, {
      helpText: "Select update mode · Esc to cancel",
    });
    if (!choice || choice === "Cancel") return;

    // Step 3: Update supipowers
    const { updated, fromVersion, toVersion } = await updateSupipowers(platform, ctx);

    // Step 4: Handle tool installation based on chosen mode
    let installResults;
    if (choice.includes("install missing")) {
      const installable = missing.filter((d) => d.installCmd);
      if (installable.length > 0) {
        ctx.ui.notify(`Installing ${installable.length} missing tool(s)...`, "info");
        installResults = await installAll(exec, installable);
      }
    } else if (choice.includes("reinstall all")) {
      const installable = DEPENDENCIES.filter((d) => d.installCmd);
      ctx.ui.notify(`Reinstalling ${installable.length} tool(s) to latest...`, "info");
      const statuses = installable.map((d) => ({ ...d, installed: false }));
      installResults = await installAll(exec, statuses);
    }

    // Step 5: Re-scan to get updated status and show report
    const finalStatuses = await scanAll(exec);
    const versionLine = updated
      ? `supipowers: v${fromVersion} → v${toVersion}`
      : `supipowers: v${fromVersion} (no update available)`;
    const report = `Update complete:\n  ${versionLine}\n${formatReport(finalStatuses, installResults)}`;
    ctx.ui.notify(report, "info");
  })().catch((err) => {
    ctx.ui.notify(`Update failed: ${(err as Error).message}`, "error");
  });
}

export function registerUpdateCommand(platform: Platform): void {
  platform.registerCommand("supi:update", {
    description: "Update supipowers and manage tool dependencies",
    async handler(_args: string | undefined, ctx: any) {
      handleUpdate(platform, ctx);
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- tests/commands/update.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `bun run test`
Expected: All tests pass (existing tests unaffected)

- [ ] **Step 6: Commit**

```bash
git add src/commands/update.ts tests/commands/update.test.ts
git commit -m "feat(update): rewrite /supi:update as TUI with dependency scan/install"
```

---

### Task 4: Convert bin/install.mjs to TypeScript Using the Registry

**Files:**
- Create: `bin/install.ts`
- Modify: `bin/install.mjs` (becomes thin shim)

- [ ] **Step 1: Create the thin .mjs shim**

Replace `bin/install.mjs` content with:

```javascript
#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const result = spawnSync("bun", [join(__dirname, "install.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
```

- [ ] **Step 2: Create bin/install.ts**

This is the TypeScript rewrite of install.mjs. It keeps the same flow (detect Pi/OMP, copy files, register context-mode) but replaces the inline LSP step with the unified dependency flow from the registry.

```typescript
#!/usr/bin/env bun
// bin/install.ts

import {
  intro,
  outro,
  confirm,
  multiselect,
  spinner,
  isCancel,
  cancel,
  note,
} from "@clack/prompts";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { scanAll, scanMissing, installDep, formatReport } from "../src/deps/registry.js";
import type { ExecResult } from "../src/platform/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
const VERSION = pkg.version;

function run(cmd: string, args: string[], opts: Record<string, unknown> = {}): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8", timeout: 120_000, ...opts });
}

function bail(msg: string): never {
  cancel(msg);
  process.exit(1);
}

/** Adapter: spawnSync → async ExecResult (for registry functions) */
async function exec(cmd: string, args: string[]): Promise<ExecResult> {
  const r = run(cmd, args);
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function findOmpBinary(): string | null {
  const check = run("omp", ["--version"]);
  if (!check.error && check.status === 0) return "omp";
  const bunPath = join(homedir(), ".bun", "bin", "omp");
  if (existsSync(bunPath)) {
    const fallback = run(bunPath, ["--version"]);
    if (!fallback.error && fallback.status === 0) return bunPath;
  }
  return null;
}

function findPiBinary(): string | null {
  const check = run("pi", ["--version"]);
  if (!check.error && check.status === 0) return "pi";
  for (const candidate of [
    join(homedir(), ".bun", "bin", "pi"),
    join(homedir(), ".npm-global", "bin", "pi"),
    "/usr/local/bin/pi",
    "/opt/homebrew/bin/pi",
  ]) {
    if (existsSync(candidate)) {
      const fallback = run(candidate, ["--version"]);
      if (!fallback.error && fallback.status === 0) return candidate;
    }
  }
  return null;
}

function installToPlatform(platformDir: string, packageRoot: string): string {
  const agentDir = join(homedir(), platformDir, "agent");
  const extDir = join(agentDir, "extensions", "supipowers");
  const installedPkgPath = join(extDir, "package.json");

  let installedVersion: string | null = null;
  if (existsSync(installedPkgPath)) {
    try {
      const installed = JSON.parse(readFileSync(installedPkgPath, "utf8"));
      installedVersion = installed.version;
    } catch { /* corrupted */ }
  }

  if (installedVersion === VERSION) {
    note(`supipowers v${VERSION} is already installed and up to date.`, `Up to date (${platformDir})`);
    return extDir;
  }

  const action = installedVersion ? "Updating" : "Installing";
  if (installedVersion) {
    note(`v${installedVersion} → v${VERSION}`, `Updating supipowers (${platformDir})`);
  }

  const s = spinner();
  s.start(`${action} supipowers to ~/${platformDir}/agent/...`);

  try {
    if (existsSync(extDir)) rmSync(extDir, { recursive: true });
    mkdirSync(extDir, { recursive: true });
    cpSync(join(packageRoot, "src"), join(extDir, "src"), { recursive: true });
    cpSync(join(packageRoot, "bin"), join(extDir, "bin"), { recursive: true });
    cpSync(join(packageRoot, "package.json"), join(extDir, "package.json"));

    const skillsSource = join(packageRoot, "skills");
    if (existsSync(skillsSource)) {
      for (const entry of readdirSync(skillsSource, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(skillsSource, entry.name, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        const destDir = join(agentDir, "skills", entry.name);
        mkdirSync(destDir, { recursive: true });
        cpSync(skillFile, join(destDir, "SKILL.md"));
      }
    }

    s.stop(installedVersion
      ? `supipowers updated to v${VERSION} (${platformDir})`
      : `supipowers v${VERSION} installed (${platformDir})`);
  } catch (err) {
    s.stop(`${action} failed (${platformDir})`);
    bail((err as Error).message || `Failed to copy files to ~/${platformDir}/agent/`);
  }

  return extDir;
}

function registerContextMode(platformDir: string, extDir: string): void {
  const ctxSpinner = spinner();
  ctxSpinner.start(`Checking for context-mode (${platformDir})...`);

  const ctxCacheBase = join(homedir(), ".claude", "plugins", "cache", "context-mode", "context-mode");
  let ctxInstallPath: string | null = null;
  if (existsSync(ctxCacheBase)) {
    const versions = readdirSync(ctxCacheBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    if (versions.length > 0) {
      const candidate = join(ctxCacheBase, versions[0], "start.mjs");
      if (existsSync(candidate)) ctxInstallPath = join(ctxCacheBase, versions[0]);
    }
  }

  if (ctxInstallPath) {
    const mcpConfigPath = join(homedir(), platformDir, "agent", "mcp.json");
    let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
    if (existsSync(mcpConfigPath)) {
      try {
        mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
        if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      } catch { mcpConfig = { mcpServers: {} }; }
    }

    const startMjs = join(ctxInstallPath, "start.mjs");
    const wrapperMjs = join(extDir, "bin", "ctx-mode-wrapper.mjs");
    mcpConfig.mcpServers["context-mode"] = { command: "node", args: [wrapperMjs, startMjs] };

    mkdirSync(join(homedir(), platformDir, "agent"), { recursive: true });
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    ctxSpinner.stop(`context-mode registered in ~/${platformDir}/agent/mcp.json`);
  } else {
    ctxSpinner.stop(`context-mode not found — install it as a Claude Code plugin for context window protection (${platformDir})`);
  }
}

// ── Main ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const skipDeps = args.includes("--skip-deps");

async function main() {
  intro(`supipowers v${VERSION}`);

  // Step 1: Detect platforms
  const detectSpinner = spinner();
  detectSpinner.start("Looking for Pi and OMP...");
  const piBin = findPiBinary();
  const ompBin = findOmpBinary();

  const piVer = piBin ? run(piBin, ["--version"]).stdout?.trim() || "unknown" : null;
  const ompVer = ompBin ? run(ompBin, ["--version"]).stdout?.trim() || "unknown" : null;

  const detected: string[] = [];
  if (piBin) detected.push(`Pi ${piVer}`);
  if (ompBin) detected.push(`OMP ${ompVer}`);
  detectSpinner.stop(detected.length ? `Detected: ${detected.join(", ")}` : "No agents found");

  // Step 2: Determine install targets
  let targets: Array<{ name: string; dir: string }> = [];

  if (piBin && ompBin) {
    const chosen = await multiselect({
      message: "Both Pi and OMP detected. Install supipowers to which?",
      options: [
        { value: { name: "Pi", dir: ".pi" }, label: `Pi (${piVer})`, hint: piBin },
        { value: { name: "OMP", dir: ".omp" }, label: `OMP (${ompVer})`, hint: ompBin },
      ],
      required: true,
    });
    if (isCancel(chosen)) bail("Installation cancelled.");
    targets = chosen as typeof targets;
  } else if (piBin) {
    const ok = await confirm({ message: `Install supipowers to Pi (${piVer})?` });
    if (isCancel(ok) || !ok) bail("Installation cancelled.");
    targets = [{ name: "Pi", dir: ".pi" }];
  } else if (ompBin) {
    const ok = await confirm({ message: `Install supipowers to OMP (${ompVer})?` });
    if (isCancel(ok) || !ok) bail("Installation cancelled.");
    targets = [{ name: "OMP", dir: ".omp" }];
  } else {
    note(
      "Pi is an AI coding agent that supipowers extends.\n" +
      "It adds sub-agents, LSP integration, and plugin support.\n" +
      "Learn more: https://github.com/mariozechner/pi-coding-agent",
      "No agent found",
    );
    const shouldInstall = await confirm({ message: "Install Pi now via npm?" });
    if (isCancel(shouldInstall) || !shouldInstall) bail("Cannot continue without Pi or OMP.");

    const s = spinner();
    s.start("Installing Pi via npm...");
    const result = run("npm", ["install", "-g", "@mariozechner/pi-coding-agent"]);
    if (result.status !== 0) {
      s.stop("Pi installation failed");
      bail(result.stderr?.trim() || "Unknown error during Pi install.");
    }
    s.stop("Pi installed successfully");

    const newPiBin = findPiBinary();
    if (!newPiBin) bail("Pi was installed but the binary was not found in PATH. Try restarting your shell.");
    targets = [{ name: "Pi", dir: ".pi" }];
  }

  // Step 3: Install supipowers to each target
  const packageRoot = resolve(__dirname, "..");

  for (const target of targets) {
    const extDir = installToPlatform(target.dir, packageRoot);
    registerContextMode(target.dir, extDir);
  }

  // Step 4: Dependency verification
  if (skipDeps) {
    note("Dependency check skipped (--skip-deps)", "Dependencies");
  } else {
    const depSpinner = spinner();
    depSpinner.start("Checking dependencies...");
    const allStatuses = await scanAll(exec);
    const missing = allStatuses.filter((d) => !d.installed && d.installCmd);
    const missingRequired = allStatuses.filter((d) => !d.installed && d.required);
    depSpinner.stop(
      missing.length > 0
        ? `${missing.length} optional tool(s) not installed`
        : "All dependencies satisfied",
    );

    // Report required missing deps that can't be auto-installed
    if (missingRequired.length > 0) {
      const reqLines = missingRequired.map((d) => `  • ${d.name}: ${d.url}`).join("\n");
      note(`Required dependencies missing:\n${reqLines}`, "⚠ Action needed");
    }

    if (missing.length > 0) {
      const depNames = missing.map((d) => `${d.name} (${d.description})`);
      const shouldInstall = await confirm({
        message: `Install ${missing.length} missing tool(s)?\n${depNames.map((n) => `  • ${n}`).join("\n")}`,
      });

      if (!isCancel(shouldInstall) && shouldInstall) {
        for (const dep of missing) {
          const s = spinner();
          s.start(`Installing ${dep.name}...`);
          const result = await installDep(exec, dep.name);
          if (result.success) {
            s.stop(`${dep.name} installed`);
          } else {
            s.stop(`${dep.name} failed — ${result.error}`);
          }
        }
      }
    }

    // Final report
    const finalStatuses = await scanAll(exec);
    const stillMissing = finalStatuses.filter((d) => !d.installed);
    if (stillMissing.length > 0) {
      const report = formatReport(stillMissing);
      note(`Some tools still need manual installation:\n${report}`, "Manual steps");
    }
  }

  // Done
  const targetNames = targets.map((t) => t.name.toLowerCase()).join(" or ");
  outro(`supipowers is ready! Run \`${targetNames}\` to start using it.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Update package.json bin field to use the shim**

The `bin` field in `package.json` already points to `bin/install.mjs`, which is now the thin shim. No change needed.

- [ ] **Step 4: Test the CLI manually**

Run: `bun bin/install.ts --skip-deps`
Expected: The installer runs, detects Pi/OMP, copies files, skips deps.

Run: `bun bin/install.ts`
Expected: Full flow including dependency scan and install prompts.

- [ ] **Step 5: Run the full test suite**

Run: `bun run test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add bin/install.ts bin/install.mjs
git commit -m "feat(install): convert installer to TypeScript with unified dependency flow"
```

---

### Task 5: Simplify doctor.ts to Delegate to the Registry

**Files:**
- Modify: `src/commands/doctor.ts`

- [ ] **Step 1: Read the current doctor.ts**

Read `src/commands/doctor.ts` fully to identify which checks can delegate to the registry.

- [ ] **Step 2: Replace checkEventStore with registry check**

In `src/commands/doctor.ts`, replace the `checkEventStore` function body to use the registry's bun:sqlite check:

```typescript
import { DEPENDENCIES } from "../deps/registry.js";

export async function checkEventStore(): Promise<CheckResult> {
  const bunSqliteDep = DEPENDENCIES.find((d) => d.binary === "__bun_sqlite__");
  if (!bunSqliteDep) {
    return { name: "EventStore", presence: { ok: false, detail: "bun:sqlite dependency not registered" } };
  }
  const { installed } = await bunSqliteDep.checkFn(async () => ({ stdout: "", stderr: "", code: 1 }));
  if (installed) {
    return { name: "EventStore", presence: { ok: true, detail: "bun:sqlite available" }, functional: { ok: true, detail: "SQLite + FTS5 functional" } };
  }
  return { name: "EventStore", presence: { ok: false, detail: "bun:sqlite not available (requires Bun runtime)" } };
}
```

- [ ] **Step 3: Run the doctor tests**

Run: `bun run test -- tests/commands/doctor.test.ts`
Expected: All doctor tests pass.

- [ ] **Step 4: Run the full test suite**

Run: `bun run test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts
git commit -m "refactor(doctor): delegate EventStore check to dependency registry"
```

---

### Task 6: Thin Out context-mode/installer.ts

**Files:**
- Modify: `src/context-mode/installer.ts`

- [ ] **Step 1: Rewrite installer.ts to delegate to registry**

```typescript
// src/context-mode/installer.ts
import { detectContextMode } from "./detector.js";
import { DEPENDENCIES, installDep } from "../deps/registry.js";
import type { ExecResult } from "../platform/types.js";

type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface ContextModeInstallStatus {
  cliInstalled: boolean;
  mcpConfigured: boolean;
  toolsAvailable: boolean;
  version: string | null;
}

export async function checkInstallation(
  exec: ExecFn,
  activeTools: string[],
): Promise<ContextModeInstallStatus> {
  const status = detectContextMode(activeTools);
  const dep = DEPENDENCIES.find((d) => d.binary === "context-mode");
  const check = dep ? await dep.checkFn(exec) : { installed: false };

  return {
    cliInstalled: check.installed,
    mcpConfigured: status.available,
    toolsAvailable: status.available,
    version: check.version ?? null,
  };
}

export async function installContextMode(
  exec: ExecFn,
): Promise<{ success: boolean; error?: string }> {
  return installDep(exec, "context-mode");
}
```

- [ ] **Step 2: Run the full test suite**

Run: `bun run test`
Expected: All tests pass (installer.ts API is unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/context-mode/installer.ts
git commit -m "refactor(context-mode): delegate check/install to dependency registry"
```

---

### Task 7: Final Integration Verification

**Files:** None (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun run test`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No new errors introduced (same 366 pre-existing test-file errors from vitest globals).

- [ ] **Step 3: Verify CLI install path**

Run: `bun bin/install.ts --skip-deps`
Expected: Installer runs correctly with the TypeScript source.

- [ ] **Step 4: Commit any fixes if needed**

Only if Steps 1-3 revealed issues.
