import * as fs from "node:fs";
import * as path from "node:path";
import type { RunManifest, AgentResult } from "../types.js";
import type { PlatformPaths } from "../platform/types.js";

function getRunsDir(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "runs");
}

function getRunDir(paths: PlatformPaths, cwd: string, runId: string): string {
  return path.join(getRunsDir(paths, cwd), runId);
}

/** Generate a unique run ID */
export function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `run-${date}-${time}-${suffix}`;
}

/** Create a new run */
export function createRun(paths: PlatformPaths, cwd: string, manifest: RunManifest): void {
  const runDir = getRunDir(paths, cwd, manifest.id);
  fs.mkdirSync(path.join(runDir, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
}

/** Load a run manifest */
export function loadRun(paths: PlatformPaths, cwd: string, runId: string): RunManifest | null {
  const filePath = path.join(getRunDir(paths, cwd, runId), "manifest.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Update a run manifest */
export function updateRun(paths: PlatformPaths, cwd: string, manifest: RunManifest): void {
  const filePath = path.join(getRunDir(paths, cwd, manifest.id), "manifest.json");
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n");
}

/** Save an agent result */
export function saveAgentResult(
  paths: PlatformPaths,
  cwd: string,
  runId: string,
  result: AgentResult
): void {
  const filePath = path.join(
    getRunDir(paths, cwd, runId),
    "agents",
    `task-${result.taskId}.json`
  );
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2) + "\n");
}

/** Load an agent result */
export function loadAgentResult(
  paths: PlatformPaths,
  cwd: string,
  runId: string,
  taskId: number
): AgentResult | null {
  const filePath = path.join(
    getRunDir(paths, cwd, runId),
    "agents",
    `task-${taskId}.json`
  );
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Load all agent results for a run */
export function loadAllAgentResults(
  paths: PlatformPaths,
  cwd: string,
  runId: string
): AgentResult[] {
  const agentsDir = path.join(getRunDir(paths, cwd, runId), "agents");
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(agentsDir, f), "utf-8"));
      } catch {
        return null;
      }
    })
    .filter((r): r is AgentResult => r !== null);
}

/** List all runs, newest first */
export function listRuns(paths: PlatformPaths, cwd: string): string[] {
  const dir = getRunsDir(paths, cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("run-"))
    .sort()
    .reverse();
}

/** Find the latest active run (running or paused) */
export function findActiveRun(paths: PlatformPaths, cwd: string): RunManifest | null {
  for (const runId of listRuns(paths, cwd)) {
    const manifest = loadRun(paths, cwd, runId);
    if (manifest && (manifest.status === "running" || manifest.status === "paused" || manifest.status === "interrupted")) {
      return manifest;
    }
  }
  return null;
}
