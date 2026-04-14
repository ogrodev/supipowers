import fs from "fs";
import path from "path";
import type { BumpType, CategorizedCommits } from "../types.js";

type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * Replace `${version}` in a tag format template with the actual version string.
 * If the template contains no placeholder, it is returned as-is.
 */
export function formatTag(version: string, tagFormat: string): string {
  return tagFormat.replace("${version}", version);
}

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

const LEGACY_RELEASE_TAG_FORMAT = "v${version}";

function getReleaseTagCandidates(version: string, tagFormat: string): string[] {
  return [...new Set([formatTag(version, tagFormat), formatTag(version, LEGACY_RELEASE_TAG_FORMAT)])];
}

async function hasMatchingReleaseTag(
  exec: ExecFn,
  cwd: string,
  args: string[],
  version: string,
  tagFormat: string,
): Promise<boolean> {
  const result = await exec("git", [...args, ...getReleaseTagCandidates(version, tagFormat)], { cwd });
  return result.code === 0 && result.stdout.trim().length > 0;
}

/**
 * Check whether a tag for the given version already exists locally.
 * Returns `true` when either the current-format tag or the legacy `v{version}`
 * tag is already known locally, which means this version was already released.
 */
export async function isVersionReleased(
  exec: ExecFn,
  cwd: string,
  version: string,
  tagFormat: string,
): Promise<boolean> {
  try {
    return await hasMatchingReleaseTag(exec, cwd, ["tag", "-l"], version, tagFormat);
  } catch {
    return false;
  }
}

/**
 * Check whether a tag for the given version exists on the remote (origin).
 * Returns true when either the current-format tag or the legacy `v{version}`
 * tag is found via `git ls-remote --tags origin`.
 */
export async function isTagOnRemote(
  exec: ExecFn,
  cwd: string,
  version: string,
  tagFormat: string,
): Promise<boolean> {
  try {
    return await hasMatchingReleaseTag(exec, cwd, ["ls-remote", "--tags", "origin"], version, tagFormat);
  } catch {
    return false;
  }
}
