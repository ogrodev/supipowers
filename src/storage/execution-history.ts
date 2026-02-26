import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDir } from "./state-store";

export interface ExecutionEvent {
  ts: number;
  type:
    | "adapter_selected"
    | "adapter_fallback"
    | "execution_started"
    | "execution_checkpoint"
    | "execution_completed"
    | "execution_failed"
    | "execution_stopped";
  runId: string;
  meta?: Record<string, unknown>;
}

function eventsFilePath(cwd: string): string {
  return join(cwd, ".pi", "supipowers", "events.jsonl");
}

export function appendExecutionEvent(cwd: string, event: ExecutionEvent): void {
  ensureStateDir(cwd);
  const filePath = eventsFilePath(cwd);
  appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");
}

export function readExecutionEvents(cwd: string): ExecutionEvent[] {
  const filePath = eventsFilePath(cwd);
  if (!existsSync(filePath)) return [];

  const lines = readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line) => JSON.parse(line) as ExecutionEvent);
}

export function writeRunArtifacts(
  cwd: string,
  runId: string,
  summaryMarkdown: string,
  details: Record<string, unknown>,
): { summaryPath: string; detailsPath: string } {
  const runsDir = join(cwd, ".pi", "supipowers", "runs", runId);
  mkdirSync(runsDir, { recursive: true });

  const summaryPath = join(runsDir, "summary.md");
  const detailsPath = join(runsDir, "details.json");

  writeFileSync(summaryPath, `${summaryMarkdown}\n`, "utf-8");
  writeFileSync(detailsPath, `${JSON.stringify(details, null, 2)}\n`, "utf-8");

  return { summaryPath, detailsPath };
}
