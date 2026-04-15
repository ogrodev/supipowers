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
 * Read the parsed package.json object from `<cwd>/package.json`. Returns null
 * when the file is absent or invalid.
 */
function readPackageJson(cwd: string): { version?: string; files?: unknown } | null {
  const pkgPath = path.join(cwd, "package.json");
  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    return JSON.parse(raw) as { version?: string; files?: unknown };
  } catch {
    return null;
  }
}

/**
 * Read the `version` field from `<cwd>/package.json`.
 * Returns `"0.0.0"` when the file is absent or carries no version field.
 */
export function getCurrentVersion(cwd: string): string {
  return readPackageJson(cwd)?.version ?? "0.0.0";
}

/**
 * Return the publishable package paths used to scope release-note commits.
 * Returns null when the package manifest does not declare a `files` whitelist.
 */
export function getPublishedPackagePaths(cwd: string): string[] | null {
  const files = readPackageJson(cwd)?.files;
  if (!Array.isArray(files)) {
    return null;
  }

  const normalized = files
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(Boolean);

  if (normalized.length === 0) {
    return null;
  }

  return [...new Set(["package.json", ...normalized])];
}

interface ParsedReleaseTag {
  tag: string;
  version: string;
}

const SEMVER_CAPTURE = "([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractVersionFromTag(tag: string, tagFormat: string): string | null {
  if (!tagFormat.includes("${version}")) {
    return null;
  }

  const pattern = `^${escapeRegExp(tagFormat).replace(escapeRegExp("${version}"), SEMVER_CAPTURE)}$`;
  const match = tag.match(new RegExp(pattern));
  return match?.[1] ?? null;
}

function parseReleaseTag(tag: string, tagFormat: string): ParsedReleaseTag | null {
  const version = extractVersionFromTag(tag, tagFormat) ?? extractVersionFromTag(tag, LEGACY_RELEASE_TAG_FORMAT);
  return version ? { tag, version } : null;
}

function compareSemver(left: string, right: string): number {
  const [leftCore] = left.split("-");
  const [rightCore] = right.split("-");
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  if (left === right) {
    return 0;
  }

  return left.includes("-") ? -1 : 1;
}

async function isTagAtHead(exec: ExecFn, cwd: string, tag: string): Promise<boolean> {
  const [tagCommit, headCommit] = await Promise.all([
    exec("git", ["rev-list", "-n", "1", tag], { cwd }),
    exec("git", ["rev-parse", "HEAD"], { cwd }),
  ]);

  return tagCommit.code === 0
    && headCommit.code === 0
    && tagCommit.stdout.trim() !== ""
    && tagCommit.stdout.trim() === headCommit.stdout.trim();
}

export async function findResumableLocalRelease(
  exec: ExecFn,
  cwd: string,
  currentVersion: string,
  tagFormat: string,
): Promise<{ version: string; tag: string } | null> {
  try {
    const localTags = await exec("git", ["tag", "--merged", "HEAD"], { cwd });
    if (localTags.code !== 0) {
      return null;
    }

    const candidates = localTags.stdout
      .split(/\r?\n/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => parseReleaseTag(tag, tagFormat))
      .filter((candidate): candidate is ParsedReleaseTag => Boolean(candidate))
      .filter((candidate) => compareSemver(candidate.version, currentVersion) > 0)
      .sort((left, right) => compareSemver(right.version, left.version));

    for (const candidate of candidates) {
      const remoteTag = await exec("git", ["ls-remote", "--tags", "origin", candidate.tag], { cwd });
      if (remoteTag.code !== 0 || remoteTag.stdout.trim() !== "") {
        continue;
      }

      if (await isTagAtHead(exec, cwd, candidate.tag)) {
        return { version: candidate.version, tag: candidate.tag };
      }
    }

    return null;
  } catch {
    return null;
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
