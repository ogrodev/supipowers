// src/orchestrator/prompts.ts
import type { PlanTask, SupipowersConfig } from "../types.js";
import { buildLspValidationPrompt } from "../lsp/bridge.js";

/** Build the system prompt for a sub-agent executing a task */
export function buildTaskPrompt(
  task: PlanTask,
  planContext: string,
  config: SupipowersConfig,
  lspAvailable: boolean
): string {
  const sections: string[] = [
    "# Task Assignment",
    "",
    `## Task: ${task.name}`,
    "",
    task.description,
    "",
    "## Target Files",
    ...task.files.map((f) => `- ${f}`),
    "",
    "## Acceptance Criteria",
    task.criteria,
    "",
    "## Context",
    planContext,
    "",
    "## Instructions",
    "1. Read the target files to understand current state",
    "2. Implement the changes described above",
    "3. Ensure acceptance criteria are met",
    "4. Report your status when done",
    "",
    "Report one of these statuses:",
    "- DONE: Task completed successfully, all criteria met",
    "- DONE_WITH_CONCERNS: Completed but with caveats (explain what)",
    "- BLOCKED: Cannot complete (explain why and what's needed)",
  ];

  if (lspAvailable) {
    sections.push(
      "",
      "## LSP Available",
      "You have access to the LSP tool. Use it to:",
      "- Check diagnostics after making changes",
      "- Find references before renaming symbols",
      "- Validate your work has no type errors",
      "",
      buildLspValidationPrompt(task.files)
    );
  }

  return sections.join("\n");
}

/** Build prompt for a fix agent */
export function buildFixPrompt(
  task: PlanTask,
  previousOutput: string,
  failureReason: string,
  lspAvailable: boolean
): string {
  const sections: string[] = [
    "# Fix Assignment",
    "",
    `## Original Task: ${task.name}`,
    "",
    "## What Went Wrong",
    failureReason,
    "",
    "## Previous Agent Output",
    previousOutput,
    "",
    "## Target Files",
    ...task.files.map((f) => `- ${f}`),
    "",
    "## Acceptance Criteria",
    task.criteria,
    "",
    "## Instructions",
    "1. Understand what the previous agent attempted",
    "2. Identify and fix the issue",
    "3. Verify the acceptance criteria are now met",
    "4. Report your status",
  ];

  if (lspAvailable) {
    sections.push("", buildLspValidationPrompt(task.files));
  }

  return sections.join("\n");
}

/** Build prompt for a merge/conflict resolution agent */
export function buildMergePrompt(
  conflictingFiles: string[],
  agentOutputs: { taskName: string; output: string }[]
): string {
  const sections: string[] = [
    "# Merge Assignment",
    "",
    "Multiple agents edited the same files. Resolve the conflicts.",
    "",
    "## Conflicting Files",
    ...conflictingFiles.map((f) => `- ${f}`),
    "",
    "## Agent Outputs",
  ];

  for (const { taskName, output } of agentOutputs) {
    sections.push(`### ${taskName}`, output, "");
  }

  sections.push(
    "## Instructions",
    "1. Read each conflicting file",
    "2. Understand what each agent intended",
    "3. Merge the changes so both intents are preserved",
    "4. If changes are incompatible, report BLOCKED with explanation"
  );

  return sections.join("\n");
}
