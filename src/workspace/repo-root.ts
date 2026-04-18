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
