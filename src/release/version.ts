import fs from "fs";
import path from "path";
import type { BumpType, CategorizedCommits } from "../types.js";

/**
 * Suggest a semver bump type based on categorized commits.
 * Breaking changes win over features; features win over everything else.
 */
export function suggestBump(commits: CategorizedCommits): BumpType {
  if (commits.breaking.length > 0) return "major";
  if (commits.features.length > 0) return "minor";
  return "patch";
}

/**
 * Apply a semver bump to a version string.
 * Pre-release suffixes (e.g. "-beta.1") are stripped before bumping.
 * Returns a plain "X.Y.Z" string — never prefixed with "v".
 */
export function bumpVersion(current: string, bump: BumpType): string {
  // Strip pre-release / build metadata before parsing
  const core = current.split("-")[0].split("+")[0];
  const parts = core.split(".").map(Number);

  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver string: "${current}"`);
  }

  let [major, minor, patch] = parts;

  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

/**
 * Read the `version` field from `<cwd>/package.json`.
 * Returns `"0.0.0"` when the file is absent or carries no version field.
 */
export function getCurrentVersion(cwd: string): string {
  const pkgPath = path.join(cwd, "package.json");
  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
