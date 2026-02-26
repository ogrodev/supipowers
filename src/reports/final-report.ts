import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RevalidationReport } from "../quality/types";
import { listRunHistory } from "../storage/run-history";
import { readWorkflowEvents } from "../storage/events-log";
import type { WorkflowState } from "../types";

export interface FinalReportOptions {
  finishMode: "merge" | "pr" | "keep" | "discard";
  state: WorkflowState;
  revalidation: RevalidationReport;
}

function reportsDir(cwd: string): string {
  return join(cwd, ".pi", "supipowers", "reports");
}

export function writeFinalReport(cwd: string, options: FinalReportOptions): string {
  const dir = reportsDir(cwd);
  mkdirSync(dir, { recursive: true });

  const runs = listRunHistory(cwd).slice(0, 5);
  const events = readWorkflowEvents(cwd).slice(-20);

  const lines: string[] = [];
  lines.push("# Supipowers Final Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Finish mode: ${options.finishMode}`);
  lines.push(`Objective: ${options.state.objective ?? "(not specified)"}`);
  lines.push(`Final phase: ${options.state.phase}`);
  lines.push("");

  lines.push("## Revalidation Summary");
  lines.push(`Stage: ${options.revalidation.stage}`);
  lines.push(`Strictness: ${options.revalidation.strictness}`);
  lines.push(`Result: ${options.revalidation.passed ? "PASS" : options.revalidation.blocking ? "BLOCK" : "WARN"}`);
  lines.push(`Summary: ${options.revalidation.summary}`);
  if (options.revalidation.nextActions.length > 0) {
    lines.push("Next actions:");
    options.revalidation.nextActions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));
  }
  lines.push("");

  lines.push("## Recent Runs");
  if (runs.length === 0) {
    lines.push("No execution runs found.");
  } else {
    runs.forEach((run, index) => {
      lines.push(
        `${index + 1}. ${run.runId} | adapter=${run.adapter ?? "unknown"} | status=${run.status ?? "unknown"} | summary=${run.summaryPath}`,
      );
    });
  }
  lines.push("");

  lines.push("## Recent Workflow Events");
  if (events.length === 0) {
    lines.push("No workflow events recorded.");
  } else {
    events.forEach((event) => {
      lines.push(`- ${new Date(event.ts).toISOString()} | ${event.type}${event.phase ? ` | phase=${event.phase}` : ""}`);
    });
  }

  const filePath = join(dir, `final-${Date.now()}.md`);
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}
