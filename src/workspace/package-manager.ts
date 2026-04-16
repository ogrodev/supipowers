import fs from "node:fs";
import path from "node:path";
import type { PackageManagerId } from "../types.js";

interface RootManifest {
  packageManager?: string;
  workspaces?: unknown;
}

export interface PackageManagerCommand {
  command: string;
  args: string[];
}

export interface ResolvedPackageManager {
  id: PackageManagerId;
  runScript(scriptName: string): PackageManagerCommand;
  buildCommand: PackageManagerCommand;
}

const LOCKFILE_ORDER: Array<{ file: string; manager: PackageManagerId }> = [
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
];

function readRootManifest(repoRoot: string): RootManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as RootManifest;
  } catch {
    return null;
  }
}

function parsePackageManagerField(value: string | undefined): PackageManagerId | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  if (normalized === "bun" || normalized.startsWith("bun@")) return "bun";
  if (normalized === "npm" || normalized.startsWith("npm@")) return "npm";
  if (normalized === "pnpm" || normalized.startsWith("pnpm@")) return "pnpm";
  if (normalized === "yarn" || normalized.startsWith("yarn@")) return "yarn";
  return null;
}

function hasPackageJsonWorkspaces(manifest: RootManifest | null): boolean {
  if (!manifest) {
    return false;
  }

  if (Array.isArray(manifest.workspaces)) {
    return manifest.workspaces.some((entry) => typeof entry === "string" && entry.length > 0);
  }

  if (manifest.workspaces && typeof manifest.workspaces === "object" && !Array.isArray(manifest.workspaces)) {
    const packages = (manifest.workspaces as { packages?: unknown }).packages;
    return Array.isArray(packages) && packages.some((entry) => typeof entry === "string" && entry.length > 0);
  }

  return false;
}

export function getRunScriptCommand(
  packageManager: PackageManagerId,
  scriptName: string,
): PackageManagerCommand {
  switch (packageManager) {
    case "bun":
      return { command: "bun", args: ["run", scriptName] };
    case "npm":
      return { command: "npm", args: ["run", scriptName] };
    case "pnpm":
      return { command: "pnpm", args: ["run", scriptName] };
    case "yarn":
      return { command: "yarn", args: [scriptName] };
  }
}

export function detectPackageManager(repoRoot: string): PackageManagerId {
  const manifest = readRootManifest(repoRoot);
  const manifestManager = parsePackageManagerField(manifest?.packageManager);
  if (manifestManager) {
    return manifestManager;
  }

  for (const lockfile of LOCKFILE_ORDER) {
    if (fs.existsSync(path.join(repoRoot, lockfile.file))) {
      return lockfile.manager;
    }
  }

  if (fs.existsSync(path.join(repoRoot, "pnpm-workspace.yaml"))) {
    return "pnpm";
  }

  if (hasPackageJsonWorkspaces(manifest)) {
    return "npm";
  }

  return "bun";
}

export function resolvePackageManager(repoRoot: string): ResolvedPackageManager {
  const id = detectPackageManager(repoRoot);
  return {
    id,
    runScript(scriptName: string) {
      return getRunScriptCommand(id, scriptName);
    },
    buildCommand: getRunScriptCommand(id, "build"),
  };
}
