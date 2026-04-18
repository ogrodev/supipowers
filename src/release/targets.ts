import fs from "node:fs";
import path from "node:path";
import type { PackageManagerId, ReleaseTarget, WorkspaceTarget } from "../types.js";
import { discoverWorkspaceTargets } from "../workspace/targets.js";

interface ReleaseManifest {
  name?: string;
  version?: string;
  private?: boolean;
  files?: unknown;
}

const ROOT_TAG_FORMAT = "v${version}";

function normalizeReleasePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .replace(/\/package\.json$/, "")
    .replace(/\/+$/, "");
}

function readReleaseManifest(manifestPath: string): ReleaseManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ReleaseManifest;
  } catch {
    return null;
  }
}

function normalizeFilesWhitelist(files: unknown): string[] {
  if (!Array.isArray(files)) {
    return [];
  }

  return files
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeReleasePath(entry))
    .filter(Boolean);
}

function joinTargetPath(relativeDir: string, entry: string): string {
  if (relativeDir === ".") {
    return entry;
  }
  return `${relativeDir}/${entry}`;
}

function buildPublishScopePaths(target: WorkspaceTarget, manifest: ReleaseManifest | null): string[] {
  const manifestPath = joinTargetPath(target.relativeDir, "package.json");
  const filesWhitelist = normalizeFilesWhitelist(manifest?.files);
  if (filesWhitelist.length > 0) {
    return [...new Set([manifestPath, ...filesWhitelist.map((entry) => joinTargetPath(target.relativeDir, entry))])];
  }

  const packageDirScope = target.relativeDir === "." ? "." : target.relativeDir;
  return [...new Set([manifestPath, packageDirScope])];
}

function getDefaultTagFormat(target: WorkspaceTarget): string {
  return target.kind === "root" ? ROOT_TAG_FORMAT : `${target.name}@${ROOT_TAG_FORMAT.replace("v", "")}`;
}

function hasReleaseVersion(manifest: ReleaseManifest | null): manifest is ReleaseManifest & { version: string } {
  return typeof manifest?.version === "string" && manifest.version.trim().length > 0;
}

function toReleaseTarget(target: WorkspaceTarget, manifest = readReleaseManifest(target.manifestPath)): ReleaseTarget {
  return {
    ...target,
    publishScopePaths: buildPublishScopePaths(target, manifest),
    defaultTagFormat: getDefaultTagFormat(target),
  };
}

export function discoverReleaseTargets(repoRoot: string, packageManager: PackageManagerId): ReleaseTarget[] {
  return discoverWorkspaceTargets(repoRoot, packageManager).flatMap((target) => {
    const manifest = readReleaseManifest(target.manifestPath);
    return hasReleaseVersion(manifest) ? [toReleaseTarget(target, manifest)] : [];
  });
}

export function getPublishableReleaseTargets(targets: ReleaseTarget[]): ReleaseTarget[] {
  return targets.filter((target) => !target.private);
}
