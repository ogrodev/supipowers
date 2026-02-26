import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RunHistoryItem {
  runId: string;
  adapter?: string;
  status?: string;
  summaryPath: string;
  detailsPath: string;
  updatedAt: number;
}

function runsRoot(cwd: string): string {
  return join(cwd, ".pi", "supipowers", "runs");
}

export function listRunHistory(cwd: string): RunHistoryItem[] {
  const root = runsRoot(cwd);
  if (!existsSync(root)) return [];

  const runIds = readdirSync(root);
  const items: RunHistoryItem[] = [];

  for (const runId of runIds) {
    const runDir = join(root, runId);
    const summaryPath = join(runDir, "summary.md");
    const detailsPath = join(runDir, "details.json");

    if (!existsSync(summaryPath) || !existsSync(detailsPath)) continue;

    let adapter: string | undefined;
    let status: string | undefined;
    try {
      const details = JSON.parse(readFileSync(detailsPath, "utf-8")) as Record<string, unknown>;
      adapter = typeof details.adapter === "string" ? details.adapter : undefined;
      status = typeof details.status === "string" ? details.status : undefined;
    } catch {
      // ignore details parse issues
    }

    items.push({
      runId,
      adapter,
      status,
      summaryPath,
      detailsPath,
      updatedAt: statSync(detailsPath).mtimeMs,
    });
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getLatestRun(cwd: string): RunHistoryItem | undefined {
  return listRunHistory(cwd)[0];
}
