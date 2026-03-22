import type { Platform, PlatformContext } from "../platform/types.js";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/loader.js";

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
