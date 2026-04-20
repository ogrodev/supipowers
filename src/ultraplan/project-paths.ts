import path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { UltraPlanStackId } from "../types.js";
import { resolveRepoRootFromFs } from "../workspace/repo-root.js";
import { getRootStateDir } from "../workspace/state-paths.js";

const ULTRAPLANS_DIR = "ultraplans";

function getUltraplanProjectRoot(cwd: string): string {
  return resolveRepoRootFromFs(cwd);
}

export function getUltraplanProjectName(cwd: string): string {
  const projectName = path.basename(path.normalize(getUltraplanProjectRoot(cwd)));
  if (!projectName) {
    throw new Error(`Unable to derive ultraplan project name from cwd: ${cwd}`);
  }
  return projectName;
}

export function getUltraplanProjectDir(paths: PlatformPaths, cwd: string): string {
  return getRootStateDir(paths, getUltraplanProjectRoot(cwd));
}

export function getUltraplansDir(paths: PlatformPaths, cwd: string): string {
  return path.join(getUltraplanProjectDir(paths, cwd), ULTRAPLANS_DIR);
}

export function getUltraplanIndexPath(paths: PlatformPaths, cwd: string): string {
  return path.join(getUltraplansDir(paths, cwd), "index.json");
}

export function getUltraplanSessionDir(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplansDir(paths, cwd), sessionId);
}

export function getUltraplanManifestPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), "manifest.json");
}

export function getUltraplanAuthoredJsonPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), "authored.json");
}

export function getUltraplanAuthoredMarkdownPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), "authored.md");
}

export function getUltraplanExecutionLogPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), "execution-log.jsonl");
}

export function getUltraplanHooksLogPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), "hooks-log.jsonl");
}

export function getUltraplanReviewDir(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), "review");
}

export function getUltraplanStackReviewDir(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stack: UltraPlanStackId,
): string {
  return path.join(getUltraplanReviewDir(paths, cwd, sessionId), stack);
}

export function getUltraplanDomainReviewPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stack: UltraPlanStackId,
  domainId: string,
): string {
  return path.join(getUltraplanStackReviewDir(paths, cwd, sessionId, stack), "domains", `${domainId}.json`);
}

export function getUltraplanStackReviewPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stack: UltraPlanStackId,
): string {
  return path.join(getUltraplanStackReviewDir(paths, cwd, sessionId, stack), "stack.json");
}
