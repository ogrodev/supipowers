// src/planning/render-markdown.ts
//
// Deterministic PlanSpec → markdown renderer. Every saved plan comes from
// this module, so the on-disk representation cannot drift from the
// canonical PlanSpec. Parsers in src/storage/plans.ts must be able to
// recover a valid PlanSpec from this output — covered by the round-trip
// test in tests/planning/render-markdown.test.ts.

import type { PlanSpec, PlanSpecTask } from "./spec.js";

function renderFrontmatter(spec: PlanSpec): string {
  const lines = ["---"];
  lines.push(`name: ${spec.name}`);
  if (spec.created) lines.push(`created: ${spec.created}`);
  lines.push(`tags: [${spec.tags.join(", ")}]`);
  lines.push("---");
  return lines.join("\n");
}

function renderContextSection(context: string): string {
  const body = context.trim();
  return body.length > 0 ? `## Context\n\n${body}` : "## Context\n";
}

function renderFilesList(files: string[]): string {
  if (files.length === 0) return "**files**: (none)";
  return files.map((file) => `- \`${file}\``).join("\n");
}

function renderTask(task: PlanSpecTask): string {
  const header = `### Task ${task.id}: ${task.name}${task.model ? ` [model: ${task.model}]` : ""}`;
  const parts: string[] = [header, ""];

  parts.push("**files**:");
  parts.push(renderFilesList(task.files));
  parts.push("");

  parts.push(`**criteria**: ${task.criteria}`);
  parts.push(`**complexity**: ${task.complexity}`);

  if (task.description && task.description.trim() !== task.name.trim()) {
    parts.push("");
    parts.push(task.description.trim());
  }

  return parts.join("\n");
}

/**
 * Render a validated PlanSpec to the canonical markdown representation
 * accepted by src/storage/plans.ts's parser. Output is stable across
 * identical input so diffs stay reviewable.
 */
export function renderPlanSpec(spec: PlanSpec): string {
  const sections: string[] = [
    renderFrontmatter(spec),
    "",
    `# ${spec.name}`,
    "",
    renderContextSection(spec.context),
  ];

  if (spec.tasks.length > 0) {
    sections.push("");
    sections.push("## Tasks");
    for (const task of spec.tasks) {
      sections.push("");
      sections.push(renderTask(task));
    }
  }

  // Trailing newline for POSIX hygiene.
  return sections.join("\n") + "\n";
}
