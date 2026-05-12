import { homedir } from "node:os";
import path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { MempalaceConfig, SupipowersConfig } from "../types.js";
import { getProjectStateDir } from "../workspace/state-paths.js";
import { resolveRepoIdentityRootFromFs } from "../workspace/repo-root.js";

export interface ResolvedMempalaceConfig extends MempalaceConfig {
  managedVenvPath: string;
  palacePath: string;
  managedVenvPathDisplay: string;
  palacePathDisplay: string;
}

function expandUserPath(input: string, cwd: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return homedir();
  }

  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homedir(), trimmed.slice(2));
  }

  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
}

function sanitizedWing(value: string): string {
  // MemPalace's own normalize_wing_name canonicalizes wing slugs with
  // underscores (`hyphens` and spaces are folded to `_`). We mirror that
  // here so a project directory like `sij_mono` and a supipowers-resolved
  // wing `sij-mono` collapse to the same slug; otherwise data ends up
  // split across two wings (`sij_mono` vs `sij-mono`) and search/diary
  // writes diverge between the CLI and the hook bridge.
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s/\\-]+/g, "_")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeMempalaceWing(value: string): string {
  return sanitizedWing(value) || "project";
}

export function resolveMempalaceConfig(
  config: SupipowersConfig,
  cwd: string,
  _paths: PlatformPaths,
): ResolvedMempalaceConfig {
  const raw = config.mempalace;
  return {
    ...raw,
    managedVenvPath: expandUserPath(raw.managedVenvPath, cwd),
    palacePath: expandUserPath(raw.palacePath, cwd),
    managedVenvPathDisplay: raw.managedVenvPath,
    palacePathDisplay: raw.palacePath,
  };
}

export function resolveDefaultWing(
  config: Pick<ResolvedMempalaceConfig, "defaultWingStrategy" | "explicitWing">,
  cwd: string,
  paths: PlatformPaths,
): string {
  if (config.defaultWingStrategy === "explicit") {
    const explicit = sanitizedWing(config.explicitWing ?? "");
    if (!explicit) {
      throw new Error("mempalace.defaultWingStrategy is explicit but explicitWing is empty");
    }
    return explicit;
  }

  if (config.defaultWingStrategy === "project-slug") {
    return normalizeMempalaceWing(path.basename(getProjectStateDir(paths, cwd)));
  }

  return normalizeMempalaceWing(path.basename(resolveRepoIdentityRootFromFs(cwd)));
}
