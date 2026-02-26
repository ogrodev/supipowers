import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { QaAuthProfile, QaMatrix } from "./types";

const QA_RUNS_DIR = [".pi", "supipowers", "qa-runs"];
const QA_AUTH_DIR = [".pi", "supipowers", "qa", "auth"];
const GITIGNORE_RULE = ".pi/";

export interface QaRunWorkspace {
  runId: string;
  runDir: string;
  runDirRelative: string;
  screenshotsDir: string;
  screenshotsDirRelative: string;
  matrixPath: string;
  matrixPathRelative: string;
  executionLogPath: string;
  executionLogPathRelative: string;
  findingsPath: string;
  findingsPathRelative: string;
}

export function createQaRunWorkspace(cwd: string, runId?: string): QaRunWorkspace {
  const resolvedRunId = runId ?? `qa-${Date.now()}`;
  const runDir = join(cwd, ...QA_RUNS_DIR, resolvedRunId);
  const screenshotsDir = join(runDir, "screenshots");

  mkdirSync(screenshotsDir, { recursive: true });

  const matrixPath = join(runDir, "matrix.json");
  const executionLogPath = join(runDir, "execution-log.jsonl");
  const findingsPath = join(runDir, "findings.md");

  return {
    runId: resolvedRunId,
    runDir,
    runDirRelative: relative(cwd, runDir) || runDir,
    screenshotsDir,
    screenshotsDirRelative: relative(cwd, screenshotsDir) || screenshotsDir,
    matrixPath,
    matrixPathRelative: relative(cwd, matrixPath) || matrixPath,
    executionLogPath,
    executionLogPathRelative: relative(cwd, executionLogPath) || executionLogPath,
    findingsPath,
    findingsPathRelative: relative(cwd, findingsPath) || findingsPath,
  };
}

export function writeQaMatrix(path: string, matrix: QaMatrix): void {
  writeFileSync(path, `${JSON.stringify(matrix, null, 2)}\n`, "utf-8");
}

export function appendQaExecutionLog(path: string, payload: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify(payload)}\n`, "utf-8");
}

function authProfilePath(cwd: string): string {
  return join(cwd, ...QA_AUTH_DIR, "profile.json");
}

export function loadQaAuthProfile(cwd: string): QaAuthProfile | undefined {
  const path = authProfilePath(cwd);
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as QaAuthProfile;
    if (!parsed.targetUrl || !Array.isArray(parsed.authSetupCommands)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveQaAuthProfile(cwd: string, profile: QaAuthProfile): string {
  const dir = join(cwd, ...QA_AUTH_DIR);
  mkdirSync(dir, { recursive: true });

  const path = authProfilePath(cwd);
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
  return path;
}

export function ensureQaStorageGitignored(cwd: string): { updated: boolean; path: string } {
  const gitignorePath = join(cwd, ".gitignore");

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${GITIGNORE_RULE}\n`, "utf-8");
    return { updated: true, path: gitignorePath };
  }

  const content = readFileSync(gitignorePath, "utf-8");
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const alreadyCovered = lines.includes(".pi") || lines.includes(".pi/") || lines.includes(".pi/**");
  if (alreadyCovered) {
    return { updated: false, path: gitignorePath };
  }

  const nextContent = `${content.replace(/\s*$/g, "")}\n${GITIGNORE_RULE}\n`;
  writeFileSync(gitignorePath, nextContent, "utf-8");
  return { updated: true, path: gitignorePath };
}
