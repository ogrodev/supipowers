import fs from "node:fs";
import path from "node:path";
import type { Platform } from "../platform/types.js";

interface RootManifest {
  workspaces?: unknown;
}

function hasWorkspaceManifest(repoRoot: string): boolean {
  if (fs.existsSync(path.join(repoRoot, "pnpm-workspace.yaml"))) {
    return true;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as RootManifest;
    if (Array.isArray(manifest.workspaces)) {
      return manifest.workspaces.some((entry) => typeof entry === "string" && entry.length > 0);
    }

    const workspaces = manifest.workspaces;
    if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) {
      return false;
    }

    const packages = (workspaces as { packages?: unknown }).packages;
    return Array.isArray(packages) && packages.some((entry) => typeof entry === "string" && entry.length > 0);
  } catch {
    return false;
  }
}

export function resolveRepoRootFromFs(cwd: string): string {
  let current = path.resolve(cwd);
  let packageRoot: string | null = null;

  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      packageRoot ??= current;
      if (hasWorkspaceManifest(current)) {
        return current;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return packageRoot ?? path.resolve(cwd);
    }
    current = parent;
  }
}

function resolveGitDirForRepoRoot(repoRoot: string): string | null {
  const dotGitPath = path.join(repoRoot, ".git");
  if (!fs.existsSync(dotGitPath)) {
    return null;
  }

  const dotGitStats = fs.statSync(dotGitPath);
  if (dotGitStats.isDirectory()) {
    return path.resolve(dotGitPath);
  }

  if (!dotGitStats.isFile()) {
    throw new Error(`Unable to resolve repo identity from ${repoRoot}: .git is neither a file nor directory`);
  }

  const rawPointer = fs.readFileSync(dotGitPath, "utf-8").trim();
  const match = /^gitdir:\s*(.+)$/i.exec(rawPointer);
  if (!match) {
    throw new Error(`Unable to resolve repo identity from ${repoRoot}: invalid .git gitdir pointer`);
  }

  return path.resolve(repoRoot, match[1].trim());
}

function resolveCommonGitDir(gitDir: string): string {
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Unable to resolve repo identity: gitdir does not exist at ${gitDir}`);
  }

  const commondirPath = path.join(gitDir, "commondir");
  if (!fs.existsSync(commondirPath)) {
    return gitDir;
  }

  const commondirValue = fs.readFileSync(commondirPath, "utf-8").trim();
  if (commondirValue.length === 0) {
    throw new Error(`Unable to resolve repo identity: empty commondir file at ${commondirPath}`);
  }

  const commonDir = path.resolve(gitDir, commondirValue);
  if (!fs.existsSync(commonDir)) {
    throw new Error(`Unable to resolve repo identity: common git dir does not exist at ${commonDir}`);
  }

  return commonDir;
}

export function resolveRepoIdentityRootFromFs(cwd: string): string {
  const repoRoot = resolveRepoRootFromFs(cwd);
  const gitDir = resolveGitDirForRepoRoot(repoRoot);
  if (gitDir === null) {
    return repoRoot;
  }

  const resolvedGitDir = path.resolve(gitDir);
  const commonDir = path.resolve(resolveCommonGitDir(resolvedGitDir));
  if (path.basename(commonDir) !== ".git") {
    if (commonDir === resolvedGitDir) {
      return repoRoot;
    }
    throw new Error(`Unable to resolve repo identity from ${repoRoot}: expected common git dir ending in .git, received ${commonDir}`);
  }

  const identityRoot = path.dirname(commonDir);
  if (!path.isAbsolute(identityRoot) || identityRoot === commonDir) {
    throw new Error(`Unable to resolve repo identity from ${repoRoot}: invalid identity root ${identityRoot}`);
  }

  return identityRoot;
}

export async function resolveRepoRoot(platform: Pick<Platform, "exec">, cwd: string): Promise<string> {
  try {
    const result = await platform.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (result.code === 0) {
      const repoRoot = result.stdout.trim();
      if (repoRoot.length > 0) {
        return repoRoot;
      }
    }
  } catch {
    // Fall back to filesystem-based workspace detection when git is unavailable.
  }

  return resolveRepoRootFromFs(cwd);
}
