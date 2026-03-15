// src/orchestrator/prompts.ts
import type { PlanTask, SupipowersConfig } from "../types.js";
import { buildLspValidationPrompt } from "../lsp/bridge.js";
import { buildImplementerPrompt } from "./agent-prompts.js";
import { buildReceivingReviewInstructions } from "../discipline/receiving-review.js";

/** Build the system prompt for a sub-agent executing a task */
export function buildTaskPrompt(
  task: PlanTask,
  planContext: string,
  config: SupipowersConfig,
  lspAvailable: boolean,
  contextModeAvailable = false,
  workDir?: string,
): string {
  let result = buildImplementerPrompt({
    task,
    planContext,
    workDir: workDir ?? process.cwd(),
  });

  if (lspAvailable) {
    result = [
      result,
      "",
      "## LSP Available",
      "You have access to the LSP tool. Use it to:",
      "- Check diagnostics after making changes",
      "- Find references before renaming symbols",
      "- Validate your work has no type errors",
      "",
      buildLspValidationPrompt(task.files),
    ].join("\n");
  }

  if (contextModeAvailable) {
    result = [
      result,
      "",
      "## Context Mode Available",
      "You have access to context-mode sandbox tools. Prefer them for large operations:",
      "- Use `ctx_batch_execute` for multi-step operations",
      "- Use `ctx_search` for querying indexed knowledge",
      "- Use `ctx_execute` for single commands with large output",
      "- Do NOT use `curl`/`wget` \u2014 use `ctx_fetch_and_index`",
      "- Do NOT use Read for analyzing large files \u2014 use `ctx_execute_file`",
      "- Keep output under 500 words; write large artifacts to files",
    ].join("\n");
  }

  return result;
}

/** Build prompt for a fix agent */
export function buildFixPrompt(
  task: PlanTask,
  previousOutput: string,
  failureReason: string,
  lspAvailable: boolean,
  contextModeAvailable = false,
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
    "",
    "---",
    "",
    buildReceivingReviewInstructions(),
  ];

  if (lspAvailable) {
    sections.push("", buildLspValidationPrompt(task.files));
  }

  if (contextModeAvailable) {
    sections.push(
      "",
      "## Context Mode Available",
      "You have access to context-mode sandbox tools. Prefer them for large operations:",
      "- Use `ctx_batch_execute` for multi-step operations",
      "- Use `ctx_search` for querying indexed knowledge",
      "- Use `ctx_execute` for single commands with large output",
      "- Do NOT use `curl`/`wget` \u2014 use `ctx_fetch_and_index`",
      "- Do NOT use Read for analyzing large files \u2014 use `ctx_execute_file`",
      "- Keep output under 500 words; write large artifacts to files",
    );
  }

  return sections.join("\n");
}

/** Build prompt for a merge/conflict resolution agent */
export function buildMergePrompt(
  conflictingFiles: string[],
  agentOutputs: { taskName: string; output: string }[],
  contextModeAvailable = false,
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

  if (contextModeAvailable) {
    sections.push(
      "",
      "## Context Mode Available",
      "Prefer context-mode sandbox tools for large operations.",
    );
  }

  return sections.join("\n");
}
