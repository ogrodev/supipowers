import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import { isReviewSession } from "../review/types.js";
import type { ReviewSession, WorkspaceTarget } from "../types.js";
import { getTargetStatePath } from "../workspace/state-paths.js";

const SESSIONS_DIR = "reviews";
const ITERATIONS_DIR = "iterations";
const AGENTS_DIR = "agents";

function getSessionsDir(paths: PlatformPaths, cwd: string, target?: WorkspaceTarget | null): string {
  return target
    ? getTargetStatePath(paths, target, SESSIONS_DIR)
    : paths.project(cwd, SESSIONS_DIR);
}

function ensureLayout(sessionDir: string): void {
  fs.mkdirSync(path.join(sessionDir, ITERATIONS_DIR), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, AGENTS_DIR), { recursive: true });
}

function getLedgerPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  target?: WorkspaceTarget | null,
): string {
  return path.join(getReviewSessionDir(paths, cwd, sessionId, target), "session.json");
}

function resolveArtifactPath(sessionDir: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Artifact path must be a non-empty relative path.");
  }

  const resolved = path.resolve(sessionDir, relativePath);
  const normalizedBase = path.resolve(sessionDir);
  if (resolved !== normalizedBase && !resolved.startsWith(`${normalizedBase}${path.sep}`)) {
    throw new Error("Artifact path must stay within the review session directory.");
  }

  return resolved;
}

export function getReviewSessionDir(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  target?: WorkspaceTarget | null,
): string {
  return path.join(getSessionsDir(paths, cwd, target), sessionId);
}

export function generateReviewSessionId(now = new Date()): string {
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `review-${date}-${time}-${suffix}`;
}

export function createReviewSession(
  paths: PlatformPaths,
  cwd: string,
  session: ReviewSession,
  target?: WorkspaceTarget | null,
): void {
  const sessionDir = getReviewSessionDir(paths, cwd, session.id, target);
  ensureLayout(sessionDir);
  fs.writeFileSync(getLedgerPath(paths, cwd, session.id, target), `${JSON.stringify(session, null, 2)}\n`);
}

export function loadReviewSession(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  target?: WorkspaceTarget | null,
): ReviewSession | null {
  const ledgerPath = getLedgerPath(paths, cwd, sessionId, target);
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
    return isReviewSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function updateReviewSession(
  paths: PlatformPaths,
  cwd: string,
  session: ReviewSession,
  target?: WorkspaceTarget | null,
): void {
  session.updatedAt = new Date().toISOString();
  const sessionDir = getReviewSessionDir(paths, cwd, session.id, target);
  ensureLayout(sessionDir);
  fs.writeFileSync(getLedgerPath(paths, cwd, session.id, target), `${JSON.stringify(session, null, 2)}\n`);
}

export function listReviewSessions(paths: PlatformPaths, cwd: string, target?: WorkspaceTarget | null): string[] {
  const sessionsDir = getSessionsDir(paths, cwd, target);
  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  return fs
    .readdirSync(sessionsDir)
    .filter((entry) => entry.startsWith("review-"))
    .sort()
    .reverse();
}

export function writeReviewArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  relativePath: string,
  payload: unknown,
  target?: WorkspaceTarget | null,
): string {
  const sessionDir = getReviewSessionDir(paths, cwd, sessionId, target);
  ensureLayout(sessionDir);
  const artifactPath = resolveArtifactPath(sessionDir, relativePath);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });

  const content = typeof payload === "string"
    ? payload
    : `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(artifactPath, content);
  return artifactPath;
}

export function readReviewArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  relativePath: string,
  target?: WorkspaceTarget | null,
): string | null {
  const sessionDir = getReviewSessionDir(paths, cwd, sessionId, target);
  const artifactPath = resolveArtifactPath(sessionDir, relativePath);
  if (!fs.existsSync(artifactPath)) {
    return null;
  }

  return fs.readFileSync(artifactPath, "utf-8");
}
