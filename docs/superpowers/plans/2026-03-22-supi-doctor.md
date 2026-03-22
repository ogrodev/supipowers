# `/supi:doctor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/supi:doctor` TUI-only command that runs two-phase health checks (presence + functional) across core infrastructure, integrations, and platform capabilities, then renders a transparent report.

**Architecture:** Single module `src/commands/doctor.ts` exports `handleDoctor` and `registerDoctorCommand`. Checks are plain async functions returning `CheckResult` objects. Results are collected, formatted into a multi-line string, and rendered via `ctx.ui.notify()`. Follows the same patterns as `src/commands/status.ts` and `src/commands/supi.ts`.

**Tech Stack:** TypeScript, better-sqlite3 (dynamic import for check), existing `detectContextMode`, `isLspAvailable`, `loadConfig` utilities.

**Spec:** `docs/superpowers/specs/2026-03-22-supi-doctor-design.md`

---

### Task 1: Check result types and formatting helpers

**Files:**
- Create: `src/commands/doctor.ts`
- Test: `tests/commands/doctor.test.ts`

- [ ] **Step 1: Write the failing test for formatting**

```typescript
// tests/commands/doctor.test.ts
import { describe, it, expect } from "vitest";
import { formatCheckResult, formatSummary } from "../../src/commands/doctor.js";

describe("doctor formatting", () => {
  it("formats a passing two-phase check", () => {
    const result = {
      name: "Git",
      presence: { ok: true, detail: "v2.43.0" },
      functional: { ok: true, detail: "Repo detected (main)" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  Git .............. ✓ v2.43.0",
      "                     ✓ Repo detected (main)",
    ]);
  });

  it("formats a failing presence check with no functional", () => {
    const result = {
      name: "GitHub CLI",
      presence: { ok: false, detail: "not found" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  GitHub CLI ....... ✗ not found",
    ]);
  });

  it("formats a presence-only passing check", () => {
    const result = {
      name: "LSP",
      presence: { ok: true, detail: "LSP tools detected" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  LSP .............. ✓ LSP tools detected",
    ]);
  });

  it("formats presence pass + functional fail", () => {
    const result = {
      name: "npm",
      presence: { ok: true, detail: "v10.8.0" },
      functional: { ok: false, detail: "Registry unreachable" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  npm .............. ✓ v10.8.0",
      "                     ✗ Registry unreachable",
    ]);
  });

  it("counts core infra presence failures as critical", () => {
    const sections = [
      {
        title: "Core Infrastructure",
        checks: [
          { name: "Platform", presence: { ok: true, detail: "" }, functional: { ok: true, detail: "" } },
          { name: "Config", presence: { ok: true, detail: "" }, functional: { ok: false, detail: "" } },
          { name: "Git", presence: { ok: false, detail: "" } },
        ],
      },
      {
        title: "Integrations",
        checks: [
          { name: "npm", presence: { ok: false, detail: "" } },
        ],
      },
    ];
    const summary = formatSummary(sections);
    expect(summary).toContain("1 passed");
    expect(summary).toContain("2 warnings"); // Config functional fail + npm presence fail
    expect(summary).toContain("1 critical"); // Git presence fail is critical (core infra)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement types and formatting**

```typescript
// src/commands/doctor.ts
import type { Platform, PlatformContext } from "../platform/types.js";

export interface CheckResult {
  name: string;
  presence: { ok: boolean; detail: string };
  functional?: { ok: boolean; detail: string };
}

export interface SectionResult {
  title: string;
  checks: CheckResult[];
}

const LABEL_WIDTH = 19; // "  Context Mode ... " padded width

export function formatCheckResult(check: CheckResult): string[] {
  const lines: string[] = [];
  const icon = (ok: boolean) => ok ? "✓" : "✗";
  const pad = check.name + " ".repeat(Math.max(0, LABEL_WIDTH - check.name.length - 2));
  const dots = ".".repeat(Math.max(2, LABEL_WIDTH - check.name.length - 2));
  const label = `  ${check.name} ${dots} `;
  const indent = " ".repeat(label.length);

  lines.push(`${label}${icon(check.presence.ok)} ${check.presence.detail}`);

  if (check.functional) {
    lines.push(`${indent}${icon(check.functional.ok)} ${check.functional.detail}`);
  }

  return lines;
}

/** Core infra checks where a presence failure is critical (blocks the extension) */
const CRITICAL_CHECKS = new Set(["Platform", "Config", "Git"]);

export function formatSummary(sections: SectionResult[]): string {
  let passed = 0;
  let warnings = 0;
  let critical = 0;

  for (const section of sections) {
    for (const check of section.checks) {
      const presenceOk = check.presence.ok;
      const functionalOk = check.functional ? check.functional.ok : true;

      if (presenceOk && functionalOk) {
        passed++;
      } else if (!presenceOk && CRITICAL_CHECKS.has(check.name)) {
        critical++;
      } else {
        warnings++;
      }
    }
  }

  return `Summary: ${passed} passed, ${warnings} warning${warnings !== 1 ? "s" : ""}, ${critical} critical`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/commands/doctor.test.ts
git commit -m "feat(doctor): add check result types and formatting helpers"
```

---

### Task 2: Core infrastructure checks

**Files:**
- Modify: `src/commands/doctor.ts`
- Test: `tests/commands/doctor.test.ts`

- [ ] **Step 1: Write failing tests for core checks**

```typescript
// Add to tests/commands/doctor.test.ts
import { checkPlatform, checkConfig, checkStorage, checkEventStore, checkGit } from "../../src/commands/doctor.js";

describe("core infrastructure checks", () => {
  const mockPlatform = (overrides?: Partial<Platform>) => ({
    name: "omp" as const,
    exec: async (cmd: string, args: string[]) => ({ stdout: "", stderr: "", code: 0 }),
    paths: {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (cwd: string, ...s: string[]) => `/tmp/test/.omp/supipowers/${s.join("/")}`,
      global: (...s: string[]) => `/tmp/test-global/.omp/supipowers/${s.join("/")}`,
      agent: (...s: string[]) => `/tmp/test-global/.omp/agent/${s.join("/")}`,
    },
    capabilities: { agentSessions: true, compactionHooks: true, customWidgets: true, registerTool: false },
    ...overrides,
  } as unknown as Platform);

  it("checkPlatform reports platform name and exec status", async () => {
    const p = mockPlatform({
      exec: async () => ({ stdout: "ok\n", stderr: "", code: 0 }),
    });
    const result = await checkPlatform(p);
    expect(result.name).toBe("Platform");
    expect(result.presence.ok).toBe(true);
    expect(result.presence.detail).toContain("OMP");
    expect(result.functional!.ok).toBe(true);
  });

  it("checkPlatform reports exec failure", async () => {
    const p = mockPlatform({
      exec: async () => { throw new Error("boom"); },
    });
    const result = await checkPlatform(p);
    expect(result.presence.ok).toBe(true);
    expect(result.functional!.ok).toBe(false);
  });

  it("checkGit detects version and repo", async () => {
    const p = mockPlatform({
      exec: async (cmd: string, args: string[]) => {
        if (args[0] === "--version") return { stdout: "git version 2.43.0", stderr: "", code: 0 };
        if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", code: 0 };
        if (args[0] === "branch") return { stdout: "feat/doctor\n", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 1 };
      },
    });
    const result = await checkGit(p);
    expect(result.presence.ok).toBe(true);
    expect(result.presence.detail).toContain("2.43.0");
    expect(result.functional!.ok).toBe(true);
    expect(result.functional!.detail).toContain("feat/doctor");
  });

  it("checkGit reports missing git", async () => {
    const p = mockPlatform({
      exec: async () => ({ stdout: "", stderr: "", code: 127 }),
    });
    const result = await checkGit(p);
    expect(result.presence.ok).toBe(false);
  });

  it("checkEventStore verifies better-sqlite3 loads", async () => {
    const result = await checkEventStore();
    // In test env, better-sqlite3 is in devDependencies so should resolve
    expect(result.presence.ok).toBe(true);
    expect(result.functional!.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement core checks**

Add to `src/commands/doctor.ts`:

```typescript
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/loader.js";

export async function checkPlatform(platform: Platform): Promise<CheckResult> {
  const name = platform.name.toUpperCase();
  const presence = { ok: true, detail: `${name} detected` };
  try {
    const r = await platform.exec("echo", ["ok"]);
    return { name: "Platform", presence, functional: { ok: r.code === 0, detail: r.code === 0 ? "exec works" : "exec failed" } };
  } catch {
    return { name: "Platform", presence, functional: { ok: false, detail: "exec failed" } };
  }
}

export async function checkConfig(platform: Platform, cwd: string): Promise<CheckResult> {
  const projectPath = platform.paths.project(cwd, "config.json");
  const globalPath = platform.paths.global("config.json");
  const projectExists = existsSync(projectPath);
  const globalExists = existsSync(globalPath);

  // loadConfig never throws — it falls back to DEFAULT_CONFIG via readJsonSafe
  const config = loadConfig(platform.paths, cwd);

  if (!projectExists && !globalExists) {
    return {
      name: "Config",
      presence: { ok: false, detail: "No config.json found (using defaults)" },
      functional: { ok: true, detail: `defaultProfile: ${config.defaultProfile}` },
    };
  }

  const foundPath = projectExists
    ? `${platform.paths.dotDir}/supipowers/config.json (project)`
    : `~/${platform.paths.dotDir}/supipowers/config.json (global)`;

  return {
    name: "Config",
    presence: { ok: true, detail: `Found ${foundPath}` },
    functional: { ok: true, detail: `Parsed (defaultProfile: ${config.defaultProfile})` },
  };
}

export async function checkStorage(platform: Platform, cwd: string): Promise<CheckResult> {
  const dir = platform.paths.project(cwd);
  if (!existsSync(dir)) {
    return { name: "Storage", presence: { ok: false, detail: `${platform.paths.dotDir}/supipowers/ not found` } };
  }

  const tmpFile = join(dir, `.doctor-check-${Date.now()}`);
  try {
    writeFileSync(tmpFile, "ok");
    unlinkSync(tmpFile);
    return {
      name: "Storage",
      presence: { ok: true, detail: `${platform.paths.dotDir}/supipowers/ exists` },
      functional: { ok: true, detail: "Writable" },
    };
  } catch {
    return {
      name: "Storage",
      presence: { ok: true, detail: `${platform.paths.dotDir}/supipowers/ exists` },
      functional: { ok: false, detail: "Not writable" },
    };
  }
}

export async function checkEventStore(): Promise<CheckResult> {
  try {
    const mod = await import("better-sqlite3");
    const Database = mod.default;
    const presence = { ok: true, detail: "better-sqlite3 available" };
    try {
      const db = new Database(":memory:");
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS fts_test USING fts5(content)");
      db.close();
      return { name: "EventStore", presence, functional: { ok: true, detail: "SQLite + FTS5 functional" } };
    } catch (err) {
      return { name: "EventStore", presence, functional: { ok: false, detail: `FTS5 failed: ${(err as Error).message}` } };
    }
  } catch {
    return { name: "EventStore", presence: { ok: false, detail: "better-sqlite3 not available" } };
  }
}

export async function checkGit(platform: Platform): Promise<CheckResult> {
  try {
    const versionResult = await platform.exec("git", ["--version"]);
    if (versionResult.code !== 0) {
      return { name: "Git", presence: { ok: false, detail: "git not found" } };
    }
    const version = versionResult.stdout.trim().replace("git version ", "");
    const presence = { ok: true, detail: `v${version}` };

    const repoResult = await platform.exec("git", ["rev-parse", "--is-inside-work-tree"]);
    if (repoResult.code !== 0) {
      return { name: "Git", presence, functional: { ok: false, detail: "Not inside a git repo" } };
    }
    const branchResult = await platform.exec("git", ["branch", "--show-current"]);
    const branch = branchResult.stdout.trim() || "detached HEAD";
    return { name: "Git", presence, functional: { ok: true, detail: `Repo detected (${branch})` } };
  } catch {
    return { name: "Git", presence: { ok: false, detail: "git not found" } };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/commands/doctor.test.ts
git commit -m "feat(doctor): add core infrastructure checks"
```

---

### Task 3: Integration checks

**Files:**
- Modify: `src/commands/doctor.ts`
- Test: `tests/commands/doctor.test.ts`

- [ ] **Step 1: Write failing tests for integration checks**

```typescript
// Add to tests/commands/doctor.test.ts
import { checkGitHubCli, checkLsp, checkMcp, checkContextMode, checkNpm } from "../../src/commands/doctor.js";

describe("integration checks", () => {
  const mockPlatform = (execFn: Platform["exec"]) => ({
    name: "omp" as const,
    exec: execFn,
    getActiveTools: () => [] as string[],
    paths: { dotDir: ".omp" },
    capabilities: { agentSessions: true, compactionHooks: true, customWidgets: true, registerTool: false },
  } as unknown as Platform);

  it("checkGitHubCli detects version and auth", async () => {
    const p = mockPlatform(async (cmd, args) => {
      if (cmd === "gh" && args[0] === "--version") return { stdout: "gh version 2.62.0 (2024-10-01)\n", stderr: "", code: 0 };
      if (cmd === "gh" && args[0] === "auth") return { stdout: "", stderr: "Logged in to github.com account pedromendes", code: 0 };
      return { stdout: "", stderr: "", code: 1 };
    });
    const result = await checkGitHubCli(p);
    expect(result.presence.ok).toBe(true);
    expect(result.presence.detail).toContain("2.62.0");
    expect(result.functional!.ok).toBe(true);
    expect(result.functional!.detail).toContain("pedromendes");
  });

  it("checkMcp detects tools and counts servers", () => {
    const tools = [
      "mcp__plugin_figma_figma__get_screenshot",
      "mcp__plugin_figma_figma__get_metadata",
      "mcp__plugin_context-mode_context-mode__ctx_execute",
      "bash",
      "read",
    ];
    const result = checkMcp(tools);
    expect(result.presence.ok).toBe(true);
    expect(result.functional!.detail).toContain("3 tools");
    expect(result.functional!.detail).toContain("2 servers");
  });

  it("checkMcp reports no MCP tools", () => {
    const result = checkMcp(["bash", "read", "edit"]);
    expect(result.presence.ok).toBe(false);
    expect(result.presence.detail).toContain("No MCP tools");
  });

  it("checkContextMode uses detectContextMode", () => {
    const tools = [
      "mcp__plugin_context-mode_context-mode__ctx_execute",
      "mcp__plugin_context-mode_context-mode__ctx_search",
      "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
    ];
    const result = checkContextMode(tools);
    expect(result.presence.ok).toBe(true);
    expect(result.functional!.ok).toBe(true);
    expect(result.functional!.detail).toContain("ctx_execute");
    expect(result.functional!.detail).toContain("ctx_search");
  });

  it("checkLsp detects lsp tool", () => {
    const result = checkLsp(["bash", "lsp", "read"]);
    expect(result.presence.ok).toBe(true);
  });

  it("checkLsp reports missing lsp", () => {
    const result = checkLsp(["bash", "read"]);
    expect(result.presence.ok).toBe(false);
  });

  it("checkNpm detects version and registry", async () => {
    const p = mockPlatform(async (cmd, args) => {
      if (cmd === "npm" && args[0] === "--version") return { stdout: "10.8.0\n", stderr: "", code: 0 };
      if (cmd === "npm" && args[0] === "ping") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 1 };
    });
    const result = await checkNpm(p);
    expect(result.presence.ok).toBe(true);
    expect(result.presence.detail).toContain("10.8.0");
    expect(result.functional!.ok).toBe(true);
  });

  it("checkNpm reports missing npm", async () => {
    const p = mockPlatform(async () => ({ stdout: "", stderr: "", code: 127 }));
    const result = await checkNpm(p);
    expect(result.presence.ok).toBe(false);
  });

  it("checkNpm reports unreachable registry", async () => {
    const p = mockPlatform(async (cmd, args) => {
      if (cmd === "npm" && args[0] === "--version") return { stdout: "10.8.0\n", stderr: "", code: 0 };
      if (cmd === "npm" && args[0] === "ping") return { stdout: "", stderr: "", code: 1 };
      return { stdout: "", stderr: "", code: 1 };
    });
    const result = await checkNpm(p);
    expect(result.presence.ok).toBe(true);
    expect(result.functional!.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement integration checks**

Add to `src/commands/doctor.ts`:

```typescript
import { detectContextMode } from "../context-mode/detector.js";
import { isLspAvailable } from "../lsp/detector.js";

export async function checkGitHubCli(platform: Platform): Promise<CheckResult> {
  try {
    const vResult = await platform.exec("gh", ["--version"]);
    if (vResult.code !== 0) {
      return { name: "GitHub CLI", presence: { ok: false, detail: "gh not found" } };
    }
    const vMatch = vResult.stdout.match(/gh version ([\d.]+)/);
    const version = vMatch ? vMatch[1] : "unknown";
    const presence = { ok: true, detail: `v${version}` };

    const authResult = await platform.exec("gh", ["auth", "status"]);
    // gh auth status outputs to stderr on success
    const output = authResult.stderr || authResult.stdout;
    const userMatch = output.match(/account\s+(\S+)/);
    if (authResult.code === 0 && userMatch) {
      return { name: "GitHub CLI", presence, functional: { ok: true, detail: `Authenticated (${userMatch[1]})` } };
    }
    return { name: "GitHub CLI", presence, functional: { ok: false, detail: "Not authenticated" } };
  } catch {
    return { name: "GitHub CLI", presence: { ok: false, detail: "gh not found" } };
  }
}

export function checkLsp(activeTools: string[]): CheckResult {
  const available = isLspAvailable(activeTools);
  return {
    name: "LSP",
    presence: { ok: available, detail: available ? "LSP tool detected" : "LSP tool not available" },
  };
}

export function checkMcp(activeTools: string[]): CheckResult {
  const mcpTools = activeTools.filter((t) => t.startsWith("mcp__"));
  if (mcpTools.length === 0) {
    return { name: "MCP", presence: { ok: false, detail: "No MCP tools detected" } };
  }

  // Extract unique server names: mcp__<server>__<tool> → server
  const servers = new Set<string>();
  for (const tool of mcpTools) {
    const withoutPrefix = tool.slice("mcp__".length);
    const lastSep = withoutPrefix.lastIndexOf("__");
    if (lastSep > 0) {
      servers.add(withoutPrefix.slice(0, lastSep));
    }
  }

  return {
    name: "MCP",
    presence: { ok: true, detail: "MCP tools detected" },
    functional: { ok: true, detail: `${mcpTools.length} tools, ${servers.size} server${servers.size !== 1 ? "s" : ""}` },
  };
}

const CTX_TOOL_NAMES: Record<string, string> = {
  ctxExecute: "ctx_execute",
  ctxBatchExecute: "ctx_batch_execute",
  ctxExecuteFile: "ctx_execute_file",
  ctxIndex: "ctx_index",
  ctxSearch: "ctx_search",
  ctxFetchAndIndex: "ctx_fetch_and_index",
};

export function checkContextMode(activeTools: string[]): CheckResult {
  const status = detectContextMode(activeTools);
  if (!status.available) {
    return { name: "Context Mode", presence: { ok: false, detail: "No context-mode tools detected" } };
  }

  const foundNames = Object.entries(status.tools)
    .filter(([, v]) => v)
    .map(([k]) => CTX_TOOL_NAMES[k] || k);

  return {
    name: "Context Mode",
    presence: { ok: true, detail: "Tools available" },
    functional: { ok: true, detail: foundNames.join(", ") },
  };
}

export async function checkNpm(platform: Platform): Promise<CheckResult> {
  try {
    const vResult = await platform.exec("npm", ["--version"]);
    if (vResult.code !== 0) {
      return { name: "npm", presence: { ok: false, detail: "npm not found" } };
    }
    const version = vResult.stdout.trim();
    const presence = { ok: true, detail: `v${version}` };

    const pingResult = await platform.exec("npm", ["ping"]);
    if (pingResult.code === 0) {
      return { name: "npm", presence, functional: { ok: true, detail: "Registry reachable" } };
    }
    return { name: "npm", presence, functional: { ok: false, detail: "Registry unreachable" } };
  } catch {
    return { name: "npm", presence: { ok: false, detail: "npm not found" } };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/commands/doctor.test.ts
git commit -m "feat(doctor): add integration checks (gh, lsp, mcp, context-mode, npm)"
```

---

### Task 4: Platform capabilities check

**Files:**
- Modify: `src/commands/doctor.ts`
- Test: `tests/commands/doctor.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// Add to tests/commands/doctor.test.ts
import { checkCapabilities } from "../../src/commands/doctor.js";

describe("platform capabilities", () => {
  it("maps capabilities to feature descriptions", () => {
    const caps = { agentSessions: true, compactionHooks: true, customWidgets: false, registerTool: true };
    const mcpAvailable = true;
    const results = checkCapabilities(caps, mcpAvailable);
    expect(results).toHaveLength(5); // 4 caps + MCP

    const widgets = results.find((r) => r.name === "customWidgets");
    expect(widgets!.presence.ok).toBe(false);
    expect(widgets!.presence.detail).toContain("Progress widgets");

    const mcp = results.find((r) => r.name === "MCP");
    expect(mcp!.presence.ok).toBe(true);
  });

  it("reports MCP not detected", () => {
    const caps = { agentSessions: true, compactionHooks: true, customWidgets: true, registerTool: true };
    const results = checkCapabilities(caps, false);
    const mcp = results.find((r) => r.name === "MCP");
    expect(mcp!.presence.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: FAIL — function not exported

- [ ] **Step 3: Implement capabilities check**

Add to `src/commands/doctor.ts`:

```typescript
import type { PlatformCapabilities } from "../platform/types.js";

const CAPABILITY_LABELS: Record<keyof PlatformCapabilities, string> = {
  agentSessions: "Sub-agent orchestration (/supi:run)",
  compactionHooks: "Context compression",
  customWidgets: "Progress widgets",
  registerTool: "Custom tool registration",
};

export function checkCapabilities(
  capabilities: PlatformCapabilities,
  mcpAvailable: boolean,
): CheckResult[] {
  const results: CheckResult[] = [];

  for (const [key, label] of Object.entries(CAPABILITY_LABELS)) {
    const ok = capabilities[key as keyof PlatformCapabilities];
    results.push({
      name: key,
      presence: { ok, detail: ok ? label : `Not available — ${label.toLowerCase()}` },
    });
  }

  results.push({
    name: "MCP",
    presence: {
      ok: mcpAvailable,
      detail: mcpAvailable ? "Detected via active tools" : "Not detected",
    },
  });

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/commands/doctor.test.ts
git commit -m "feat(doctor): add platform capabilities check"
```

---

### Task 5: Wire up handleDoctor, register command, add to bootstrap

**Files:**
- Modify: `src/commands/doctor.ts`
- Modify: `src/bootstrap.ts`
- Test: `tests/commands/doctor.test.ts`

- [ ] **Step 1: Write failing test for handleDoctor**

```typescript
// Add to tests/commands/doctor.test.ts
import { runDoctorChecks } from "../../src/commands/doctor.js";

describe("runDoctorChecks", () => {
  it("returns three sections", async () => {
    const platform = {
      name: "omp" as const,
      exec: async (cmd: string, args: string[]) => {
        if (cmd === "echo") return { stdout: "ok\n", stderr: "", code: 0 };
        if (cmd === "git" && args[0] === "--version") return { stdout: "git version 2.43.0", stderr: "", code: 0 };
        if (cmd === "git" && args[0] === "rev-parse") return { stdout: "true\n", stderr: "", code: 0 };
        if (cmd === "git" && args[0] === "branch") return { stdout: "main\n", stderr: "", code: 0 };
        if (cmd === "gh") return { stdout: "", stderr: "", code: 127 };
        if (cmd === "npm" && args[0] === "--version") return { stdout: "10.8.0\n", stderr: "", code: 0 };
        if (cmd === "npm" && args[0] === "ping") return { stdout: "", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 1 };
      },
      getActiveTools: () => ["bash", "read", "lsp"],
      paths: {
        dotDir: ".omp",
        dotDirDisplay: ".omp",
        project: (cwd: string, ...s: string[]) => `/tmp/.omp/supipowers/${s.join("/")}`,
        global: (...s: string[]) => `/tmp/global/.omp/supipowers/${s.join("/")}`,
        agent: (...s: string[]) => `/tmp/global/.omp/agent/${s.join("/")}`,
      },
      capabilities: { agentSessions: true, compactionHooks: true, customWidgets: true, registerTool: false },
    } as unknown as Platform;

    const sections = await runDoctorChecks(platform, "/tmp/test");
    expect(sections).toHaveLength(3);
    expect(sections[0].title).toBe("Core Infrastructure");
    expect(sections[1].title).toBe("Integrations");
    expect(sections[2].title).toBe("Platform Capabilities");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: FAIL — function not exported

- [ ] **Step 3: Implement runDoctorChecks, handleDoctor, and registerDoctorCommand**

Add to `src/commands/doctor.ts`:

```typescript
export async function runDoctorChecks(platform: Platform, cwd: string): Promise<SectionResult[]> {
  const activeTools = platform.getActiveTools();

  // Core Infrastructure
  const core: CheckResult[] = [
    await checkPlatform(platform),
    await checkConfig(platform, cwd),
    await checkStorage(platform, cwd),
    await checkEventStore(),
    await checkGit(platform),
  ];

  // Integrations
  const mcpResult = checkMcp(activeTools);
  const integrations: CheckResult[] = [
    await checkGitHubCli(platform),
    checkLsp(activeTools),
    mcpResult,
    checkContextMode(activeTools),
    await checkNpm(platform),
  ];

  // Platform Capabilities
  const mcpAvailable = mcpResult.presence.ok;
  const capChecks = checkCapabilities(platform.capabilities, mcpAvailable);

  return [
    { title: "Core Infrastructure", checks: core },
    { title: "Integrations", checks: integrations },
    { title: "Platform Capabilities", checks: capChecks },
  ];
}

function formatReport(sections: SectionResult[]): string {
  const lines: string[] = ["/supi:doctor", ""];
  for (const section of sections) {
    lines.push(section.title);
    for (const check of section.checks) {
      lines.push(...formatCheckResult(check));
    }
    lines.push("");
  }
  lines.push(formatSummary(sections));
  return lines.join("\n");
}

export function handleDoctor(platform: Platform, ctx: PlatformContext): void {
  if (!ctx.hasUI) return;

  void (async () => {
    try {
      const sections = await runDoctorChecks(platform, ctx.cwd);
      const report = formatReport(sections);
      ctx.ui.notify(report, "info");
    } catch (err) {
      ctx.ui.notify(`Doctor failed: ${(err as Error).message}`, "error");
    }
  })();
}

export function registerDoctorCommand(platform: Platform): void {
  platform.registerCommand("supi:doctor", {
    description: "Run health checks on supipowers features and integrations",
    async handler(_args: string | undefined, ctx: any) {
      handleDoctor(platform, ctx);
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into bootstrap.ts**

In `src/bootstrap.ts`, add the import and registration:

```typescript
// Add import
import { registerDoctorCommand, handleDoctor } from "./commands/doctor.js";

// Add to TUI_COMMANDS
const TUI_COMMANDS: Record<string, (platform: Platform, ctx: any) => void> = {
  "supi": (platform, ctx) => handleSupi(platform, ctx),
  "supi:config": (platform, ctx) => handleConfig(platform, ctx),
  "supi:status": (platform, ctx) => handleStatus(platform, ctx),
  "supi:update": (platform, ctx) => handleUpdate(platform, ctx),
  "supi:doctor": (platform, ctx) => handleDoctor(platform, ctx),
};

// Add to bootstrap function after other registerXxxCommand calls
registerDoctorCommand(platform);
```

Also add `/supi:doctor` to the commands list in `src/commands/supi.ts`:

```typescript
const commands = [
  // ... existing commands ...
  "/supi:doctor  — Run health checks",
  // ...
];
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/commands/doctor.ts src/bootstrap.ts src/commands/supi.ts tests/commands/doctor.test.ts
git commit -m "feat(doctor): wire up command handler and register in bootstrap"
```

---

### Task 6: Manual smoke test

- [ ] **Step 1: Load extension in Pi or OMP and run `/supi:doctor`**

Run: `pi -e ./src/index.ts` (or `omp -e ./src/index.ts`)
Then type: `/supi:doctor`

Expected: formatted multi-line report with all three sections and summary.

- [ ] **Step 2: Verify `/supi` menu includes doctor**

Type: `/supi`
Expected: `/supi:doctor` appears in the command list.

- [ ] **Step 3: Fix any issues found, run tests again, commit**

Run: `npx vitest run`
Then commit any fixes.
