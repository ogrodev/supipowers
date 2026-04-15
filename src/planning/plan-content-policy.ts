interface PlanReviewCategory {
  category: string;
  detail: string;
  summaryLabel: string;
}

export const PLAN_REVIEW_CATEGORIES: readonly PlanReviewCategory[] = [
  {
    category: "Completeness",
    detail: "TODO markers, placeholders, incomplete tasks, missing steps",
    summaryLabel: "completeness",
  },
  {
    category: "Spec Alignment",
    detail: "Chunk covers relevant spec requirements, no scope creep",
    summaryLabel: "spec alignment",
  },
  {
    category: "Task Decomposition",
    detail: "Tasks atomic, clear boundaries, steps actionable",
    summaryLabel: "task decomposition",
  },
  {
    category: "File Structure",
    detail: "Files have clear single responsibilities, split by responsibility not layer",
    summaryLabel: "file structure",
  },
  {
    category: "File Size",
    detail: "Would any new or modified file likely grow large enough to be hard to reason about?",
    summaryLabel: "file size rules",
  },
  {
    category: "Checkbox Syntax",
    detail: "Steps use checkbox (`- [ ]`) syntax for tracking",
    summaryLabel: "checkbox syntax",
  },
  {
    category: "Chunk Size",
    detail: "Each chunk under 1000 lines",
    summaryLabel: "chunk size",
  },
  {
    category: "Code Content",
    detail:
      "Plans describe work in prose; code fences limited to signatures, brief pseudocode, or exact commands. No full function bodies, test bodies, or file-content dumps.",
    summaryLabel: "code-content rules",
  },
] as const;

export const PLAN_CODE_CONTENT_REQUIREMENTS = [
  "Describe what each step changes — do not dump full implementations",
  "Use function signatures or brief pseudocode only when they clarify a non-obvious interface or algorithm",
  "Do NOT include full file contents, full function bodies, or full test bodies",
  "Code fences are allowed only for short signatures, brief pseudocode, or exact commands",
] as const;

export const PLAN_CODE_CONTENT_CRITICAL_CHECKS = [
  "Full function bodies, full test bodies, or file-sized code blocks where prose or a signature would suffice",
  "Code fences that contain implementation rather than interface descriptions",
] as const;

export const PLAN_CONTENT_POLICY_SUMMARY =
  "Plans describe the work — they do not generate it. Use prose to explain what changes, code fences only for signatures, brief pseudocode, or exact commands, and never full function bodies, full test bodies, or file-content dumps.";

export const QUICK_PLAN_TASK_CONTENT_REQUIREMENT =
  "Describe what each task changes in prose. Include function signatures or brief pseudocode only when they clarify a non-obvious interface. Do NOT include full function bodies, full test bodies, or file-content dumps.";

export function formatPlanReviewCategorySummary(): string {
  return humanJoin(PLAN_REVIEW_CATEGORIES.map((category) => category.summaryLabel));
}

function humanJoin(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}
