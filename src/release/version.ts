import fs from "fs";
import type { BumpType, CategorizedCommits, ReleaseTarget } from "../types.js";

type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

interface PackageManifest {
  version?: string;
}

interface ParsedReleaseTag {
  tag: string;
  version: string;
}

const LEGACY_RELEASE_TAG_FORMAT = "v${version}";
const SEMVER_CAPTURE = "([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)";

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
  const core = current.split("-")[0].split("+")[0];
  const parts = core.split(".").map(Number);

  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver string: "${current}"`);
  }

  const [major, minor, patch] = parts;
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

function readPackageJson(manifestPath: string): PackageManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PackageManifest;
  } catch {
    return null;
  }
}

/**
 * Read the current version from the selected release target's manifest.
 * Returns "0.0.0" when the manifest is absent or carries no version field.
 */
export function getCurrentVersion(target: ReleaseTarget): string {
  return readPackageJson(target.manifestPath)?.version ?? "0.0.0";
}

/** Return the target-specific publish scope already computed during discovery. */
export function getPublishedPackagePaths(target: ReleaseTarget): string[] {
  return [...target.publishScopePaths];
}

/** Resolve the effective tag format for a selected target. */
export function getReleaseTagFormat(target: ReleaseTarget, rootTagFormat: string): string {
  return target.kind === "root" ? rootTagFormat : target.defaultTagFormat;
}

function getTagFormatsForTarget(target: ReleaseTarget, rootTagFormat: string): string[] {
  const effectiveTagFormat = getReleaseTagFormat(target, rootTagFormat);
  return target.kind === "root"
    ? [...new Set([effectiveTagFormat, LEGACY_RELEASE_TAG_FORMAT])]
    : [effectiveTagFormat];
}

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

function parseReleaseTag(tag: string, target: ReleaseTarget, rootTagFormat: string): ParsedReleaseTag | null {
  for (const tagFormat of getTagFormatsForTarget(target, rootTagFormat)) {
    const version = extractVersionFromTag(tag, tagFormat);
    if (version) {
      return { tag, version };
    }
  }

  return null;
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

async function isTagAtHead(exec: ExecFn, repoRoot: string, tag: string): Promise<boolean> {
  const [tagCommit, headCommit] = await Promise.all([
    exec("git", ["rev-list", "-n", "1", tag], { cwd: repoRoot }),
    exec("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
  ]);

  return tagCommit.code === 0
    && headCommit.code === 0
    && tagCommit.stdout.trim() !== ""
    && tagCommit.stdout.trim() === headCommit.stdout.trim();
}

export async function getLatestReleaseTag(
  exec: ExecFn,
  target: ReleaseTarget,
  rootTagFormat: string,
): Promise<string | null> {
  try {
    const localTags = await exec("git", ["tag", "--merged", "HEAD"], { cwd: target.repoRoot });
    if (localTags.code !== 0) {
      return null;
    }

    const latest = localTags.stdout
      .split(/\r?\n/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => parseReleaseTag(tag, target, rootTagFormat))
      .filter((candidate): candidate is ParsedReleaseTag => Boolean(candidate))
      .sort((left, right) => compareSemver(right.version, left.version))[0];

    return latest?.tag ?? null;
  } catch {
    return null;
  }
}

export async function findResumableLocalRelease(
  exec: ExecFn,
  target: ReleaseTarget,
  currentVersion: string,
  rootTagFormat: string,
): Promise<{ version: string; tag: string } | null> {
  try {
    const localTags = await exec("git", ["tag", "--merged", "HEAD"], { cwd: target.repoRoot });
    if (localTags.code !== 0) {
      return null;
    }

    const candidates = localTags.stdout
      .split(/\r?\n/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => parseReleaseTag(tag, target, rootTagFormat))
      .filter((candidate): candidate is ParsedReleaseTag => Boolean(candidate))
      .filter((candidate) => compareSemver(candidate.version, currentVersion) > 0)
      .sort((left, right) => compareSemver(right.version, left.version));

    for (const candidate of candidates) {
      const remoteTag = await exec("git", ["ls-remote", "--tags", "origin", candidate.tag], { cwd: target.repoRoot });
      if (remoteTag.code !== 0 || remoteTag.stdout.trim() !== "") {
        continue;
      }

      if (await isTagAtHead(exec, target.repoRoot, candidate.tag)) {
        return { version: candidate.version, tag: candidate.tag };
      }
    }

    return null;
  } catch {
    return null;
  }
}

function getReleaseTagCandidates(
  target: ReleaseTarget,
  version: string,
  rootTagFormat: string,
): string[] {
  return [...new Set(getTagFormatsForTarget(target, rootTagFormat).map((tagFormat) => formatTag(version, tagFormat)))];
}

async function hasMatchingReleaseTag(
  exec: ExecFn,
  target: ReleaseTarget,
  args: string[],
  version: string,
  rootTagFormat: string,
): Promise<boolean> {
  const result = await exec(
    "git",
    [...args, ...getReleaseTagCandidates(target, version, rootTagFormat)],
    { cwd: target.repoRoot },
  );
  return result.code === 0 && result.stdout.trim().length > 0;
}

/**
 * Check whether a tag for the given version already exists locally.
 * Root targets keep the legacy `v${version}` fallback; workspace targets do not.
 */
export async function isVersionReleased(
  exec: ExecFn,
  target: ReleaseTarget,
  version: string,
  rootTagFormat: string,
): Promise<boolean> {
  try {
    return await hasMatchingReleaseTag(exec, target, ["tag", "-l"], version, rootTagFormat);
  } catch {
    return false;
  }
}

/**
 * Check whether a tag for the given version exists on the remote (origin).
 * Root targets keep the legacy `v${version}` fallback; workspace targets do not.
 */
export async function isTagOnRemote(
  exec: ExecFn,
  target: ReleaseTarget,
  version: string,
  rootTagFormat: string,
): Promise<boolean> {
  try {
    return await hasMatchingReleaseTag(exec, target, ["ls-remote", "--tags", "origin"], version, rootTagFormat);
  } catch {
    return false;
  }
}
