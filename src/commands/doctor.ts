import type { Platform, PlatformContext, PlatformCapabilities } from "../platform/types.js";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { formatConfigErrors, inspectConfig } from "../config/loader.js";
import { detectContextMode } from "../context-mode/detector.js";
import { isLspAvailable } from "../lsp/detector.js";
import { summarizeEnabledGates } from "../quality/setup.js";
import { DEPENDENCIES } from "../deps/registry.js";

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
  const dots = ".".repeat(Math.max(2, LABEL_WIDTH - check.name.length - 2));
  const label = `  ${check.name} ${dots} `;
  const indent = " ".repeat(label.length);

  lines.push(`${label}${icon(check.presence.ok)} ${check.presence.detail}`);

  if (check.functional) {
    lines.push(`${indent}${icon(check.functional.ok)} ${check.functional.detail}`);
  }

  return lines;
}

export async function checkPlatform(platform: Platform): Promise<CheckResult> {
  const name = platform.name.toUpperCase();
  const presence = { ok: true, detail: `${name} detected` };
  try {
    const r = await platform.exec("node", ["--version"]);
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
  const inspection = inspectConfig(platform.paths, cwd);
  const config = inspection.effectiveConfig ?? DEFAULT_CONFIG;

  if (!projectExists && !globalExists) {
    return {
      name: "Config",
      presence: { ok: false, detail: "No config.json found (using defaults)" },
      functional: { ok: true, detail: `quality.gates: ${summarizeEnabledGates(config.quality.gates)}` },
    };
  }

  const foundPath = projectExists
    ? `${platform.paths.dotDir}/supipowers/config.json (project)`
    : `~/${platform.paths.dotDir}/supipowers/config.json (global)`;

  if (inspection.parseErrors.length > 0 || inspection.validationErrors.length > 0) {
    return {
      name: "Config",
      presence: { ok: true, detail: `Found ${foundPath}` },
      functional: { ok: false, detail: formatConfigErrors(inspection) },
    };
  }

  return {
    name: "Config",
    presence: { ok: true, detail: `Found ${foundPath}` },
    functional: { ok: true, detail: `quality.gates: ${summarizeEnabledGates(config.quality.gates)}` },
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
    return { name: "Context Mode", presence: { ok: false, detail: "No supi-context-mode tools detected" } };
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

const CAPABILITY_LABELS: Partial<Record<keyof PlatformCapabilities, string>> = {
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
      presence: { ok, detail: ok ? label : `Not available — ${label}` },
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

