import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PackageManagerId, WorkspaceTarget, WorkspaceTargetKind } from "../types.js";

interface WorkspaceManifest {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: unknown;
}

interface WorkspaceObjectConfig {
  packages?: unknown;
}

interface PnpmWorkspaceConfig {
  packages?: unknown;
}

const IGNORED_WORKSPACE_DIRS = new Set([".git", "node_modules"]);
export const ROOT_WORKSPACE_RELATIVE_DIR = ".";

export function normalizeWorkspaceRelativePath(value: string): string {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .replace(/\/package\.json$/, "")
    .replace(/\/+$/, "");

  return normalized.length > 0 ? normalized : ROOT_WORKSPACE_RELATIVE_DIR;
}

export function toWorkspaceRelativeDir(repoRoot: string, dir: string): string {
  return normalizeWorkspaceRelativePath(path.relative(repoRoot, dir));
}

function readManifest(manifestPath: string): WorkspaceManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as WorkspaceManifest;
  } catch {
    return null;
  }
}

function isWorkspacePackagesConfig(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readPackageJsonWorkspacePatterns(manifest: WorkspaceManifest): string[] {
  if (isWorkspacePackagesConfig(manifest.workspaces)) {
    return manifest.workspaces;
  }

  if (manifest.workspaces && typeof manifest.workspaces === "object" && !Array.isArray(manifest.workspaces)) {
    const packages = (manifest.workspaces as WorkspaceObjectConfig).packages;
    if (isWorkspacePackagesConfig(packages)) {
      return packages;
    }
  }

  return [];
}

function readPnpmWorkspacePatterns(repoRoot: string): string[] {
  const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspacePath)) {
    return [];
  }

  try {
    const parsed = parseYaml(fs.readFileSync(workspacePath, "utf-8")) as PnpmWorkspaceConfig | null;
    return isWorkspacePackagesConfig(parsed?.packages) ? parsed.packages : [];
  } catch {
    return [];
  }
}

function expandBracePatterns(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start === -1) {
    return [pattern];
  }

  const end = pattern.indexOf("}", start + 1);
  if (end === -1) {
    return [pattern];
  }

  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  return pattern
    .slice(start + 1, end)
    .split(",")
    .flatMap((option) => expandBracePatterns(`${prefix}${option}${suffix}`));
}

function normalizeWorkspacePattern(pattern: string): string {
  return normalizeWorkspaceRelativePath(pattern);
}

function listDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_WORKSPACE_DIRS.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function hasMagic(segment: string): boolean {
  return segment.includes("*") || segment.includes("?");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesSegment(name: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${escapeRegExp(pattern)
      .replace(/\\\*/g, "[^/]*")
      .replace(/\\\?/g, "[^/]")}$`,
  );
  return regex.test(name);
}

function expandWorkspacePattern(repoRoot: string, pattern: string): string[] {
  const normalizedPattern = normalizeWorkspacePattern(pattern);
  if (normalizedPattern === ROOT_WORKSPACE_RELATIVE_DIR) {
    return fs.existsSync(path.join(repoRoot, "package.json")) ? [repoRoot] : [];
  }

  const segments = normalizedPattern.split("/").filter(Boolean);
  const matches = new Set<string>();

  const visit = (currentDir: string, index: number): void => {
    if (index >= segments.length) {
      if (fs.existsSync(path.join(currentDir, "package.json"))) {
        matches.add(currentDir);
      }
      return;
    }

    const segment = segments[index];
    if (segment === "**") {
      visit(currentDir, index + 1);
      for (const child of listDirectories(currentDir)) {
        visit(path.join(currentDir, child), index);
      }
      return;
    }

    if (!hasMagic(segment)) {
      const nextDir = path.join(currentDir, segment);
      if (fs.existsSync(nextDir) && fs.statSync(nextDir).isDirectory()) {
        visit(nextDir, index + 1);
      }
      return;
    }

    for (const child of listDirectories(currentDir)) {
      if (matchesSegment(child, segment)) {
        visit(path.join(currentDir, child), index + 1);
      }
    }
  };

  visit(repoRoot, 0);
  return [...matches].sort();
}

function globPathToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeWorkspacePattern(pattern);
  if (normalizedPattern === ROOT_WORKSPACE_RELATIVE_DIR) {
    return /^\.$/;
  }

  let regex = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index];
    const nextChar = normalizedPattern[index + 1];
    if (char === "*" && nextChar === "*") {
      regex += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegExp(char);
  }

  regex += "$";
  return new RegExp(regex);
}

function collectWorkspaceDirectories(repoRoot: string, patterns: string[]): string[] {
  const expandedPatterns = patterns.flatMap((pattern) => expandBracePatterns(pattern));
  const includePatterns = expandedPatterns.filter((pattern) => !pattern.startsWith("!"));
  const excludeMatchers = expandedPatterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => globPathToRegExp(pattern.slice(1)));

  const directories = new Set<string>();
  for (const pattern of includePatterns) {
    for (const dir of expandWorkspacePattern(repoRoot, pattern)) {
      const relativeDir = toWorkspaceRelativeDir(repoRoot, dir);
      if (excludeMatchers.some((matcher) => matcher.test(relativeDir))) {
        continue;
      }
      directories.add(dir);
    }
  }

  return [...directories].sort((left, right) => {
    const leftRelative = toWorkspaceRelativeDir(repoRoot, left);
    const rightRelative = toWorkspaceRelativeDir(repoRoot, right);
    return leftRelative.localeCompare(rightRelative);
  });
}

function isWorkspaceTargetManifest(manifest: WorkspaceManifest | null): manifest is WorkspaceManifest & { name: string; version: string } {
  return typeof manifest?.name === "string"
    && manifest.name.trim().length > 0
    && typeof manifest.version === "string"
    && manifest.version.trim().length > 0;
}

function buildWorkspaceTarget(
  repoRoot: string,
  packageDir: string,
  manifest: WorkspaceManifest & { name: string; version: string },
  packageManager: PackageManagerId,
  kind: WorkspaceTargetKind,
): WorkspaceTarget {
  return {
    id: manifest.name,
    name: manifest.name,
    kind,
    repoRoot,
    packageDir,
    manifestPath: path.join(packageDir, "package.json"),
    relativeDir: toWorkspaceRelativeDir(repoRoot, packageDir),
    version: manifest.version,
    private: manifest.private === true,
    packageManager,
  };
}

export function discoverWorkspaceTargets(repoRoot: string, packageManager: PackageManagerId): WorkspaceTarget[] {
  const rootManifestPath = path.join(repoRoot, "package.json");
  const rootManifest = readManifest(rootManifestPath);
  const targetByManifestPath = new Map<string, WorkspaceTarget>();

  if (isWorkspaceTargetManifest(rootManifest)) {
    targetByManifestPath.set(
      rootManifestPath,
      buildWorkspaceTarget(repoRoot, repoRoot, rootManifest, packageManager, "root"),
    );
  }

  const workspacePatterns = [
    ...readPackageJsonWorkspacePatterns(rootManifest ?? {}),
    ...readPnpmWorkspacePatterns(repoRoot),
  ];

  for (const workspaceDir of collectWorkspaceDirectories(repoRoot, workspacePatterns)) {
    const manifestPath = path.join(workspaceDir, "package.json");
    const manifest = readManifest(manifestPath);
    if (!isWorkspaceTargetManifest(manifest)) {
      continue;
    }

    targetByManifestPath.set(
      manifestPath,
      buildWorkspaceTarget(
        repoRoot,
        workspaceDir,
        manifest,
        packageManager,
        workspaceDir === repoRoot ? "root" : "workspace",
      ),
    );
  }

  return [...targetByManifestPath.values()].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "root" ? -1 : 1;
    }
    return left.relativeDir.localeCompare(right.relativeDir);
  });
}
