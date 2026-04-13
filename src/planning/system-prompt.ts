import type { Platform } from "../platform/types.js";
import { createDebugLogger } from "../debug/logger.js";
import { getPlanningDebugLogger, getPlanningPromptOptions, isPlanningActive } from "./approval-flow.js";
import { buildPlanWriterPrompt } from "./plan-writer-prompt.js";
import { buildSpecReviewerPrompt } from "./spec-reviewer.js";

export interface PlanningSystemPromptOptions {
  skillContent?: string;
  dotDirDisplay: string;
  topic?: string;
  isQuick?: boolean;
}

const NOW_MARKER = "═══════════Now═══════════";
const RULES_MARKER = "═══════════Rules═══════════";
const SKILLS_HEADER = "# Skills\n";
const TOOLS_HEADER = "# Tools\n";
const STRIP_TAGS = [
  "default-follow-through",
  "behavior",
  "code-integrity",
  "stakes",
  "tool-persistence",
] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTagSection(prompt: string, tag: string): string {
  return prompt.replace(new RegExp(`\\n*<${tag}>[\\s\\S]*?<\\/${tag}>\\n*`, "g"), "\n\n");
}

function stripBetween(prompt: string, start: string, end: string): string {
  return prompt.replace(new RegExp(`${escapeRegex(start)}[\\s\\S]*?(?=${escapeRegex(end)})`), "");
}

function insertBeforeMarker(prompt: string, marker: string, section: string): string {
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex === -1) {
    return `${prompt.trimEnd()}\n\n${section}`.trim();
  }

  const before = prompt.slice(0, markerIndex).trimEnd();
  const after = prompt.slice(markerIndex);
  return `${before}\n\n${section}\n\n${after}`;
}

function replaceNowCriticalBlock(prompt: string, replacement: string): string {
  const markerIndex = prompt.indexOf(NOW_MARKER);
  if (markerIndex === -1) {
    return `${prompt.trimEnd()}\n\n${replacement}`.trim();
  }

  const before = prompt.slice(0, markerIndex + NOW_MARKER.length);
  const after = prompt.slice(markerIndex + NOW_MARKER.length);

  if (!after.includes("<critical>")) {
    return `${before}\n\n${replacement}${after}`;
  }

  return before + after.replace(/<critical>[\s\S]*?<\/critical>/, replacement);
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\n{3,}/g, "\n\n").trim();
}

function buildTopicLine(topic?: string): string[] {
  if (!topic) return [];
  return ["", `Initial planning request: ${topic}`];
}

function buildAdditionalGuidelines(skillContent?: string): string[] {
  if (!skillContent) return [];
  return ["", "## Additional Planning Guidelines", "", skillContent.trim()];
}

function buildFullPlanningSection(options: PlanningSystemPromptOptions): string {
  const specReviewerPrompt = buildSpecReviewerPrompt("<path-to-spec-file>");
  const planWriterPrompt = buildPlanWriterPrompt({
    specPath: "<path-to-approved-spec>",
    dotDirDisplay: options.dotDirDisplay,
  });

  return [
    "═══════════Planning Mode═══════════",
    "",
    "<planning-mode>",
    "You are in collaborative planning mode for `/supi:plan`.",
    "Help the user converge on a design, validate it, write the approved design doc, then write the implementation plan.",
    "Use repo evidence to ground recommendations, explore broadly before converging, and keep visible output concise.",
    ...buildTopicLine(options.topic),
    "</planning-mode>",
    "",
    "## HARD-GATE",
    "",
    "- Do NOT write production code, apply patches, or claim that you changed files during planning.",
    "- The only allowed file writes are the approved design doc under `.omp/supipowers/specs/` and the final implementation plan under `.omp/supipowers/plans/`.",
    "- Keep planning artifacts local. Do NOT stage, commit, or push the design doc or implementation plan.",
    "- If the user asks to jump into coding early, explain that planning mode must finish first.",
    "- When you need to ask the user a question with options, use the `planning_ask` tool instead of `ask`. It has no timeout so the user can think without pressure.",
    "",
    "## Planning Workflow",
    "",
    "### Phase 1: Explore project context",
    "- Inspect relevant files, docs, and architecture before asking questions.",
    "- If the request spans multiple independent subsystems, flag it early and help decompose it.",
    "",
    "### Phase 2: Ask clarifying questions",
    "- Determine the current planning mode: problem exploration, solution ideation, assumption testing, or strategy exploration.",
    "- Ask one question at a time.",
    "- Prefer multiple-choice questions when they reduce ambiguity.",
    "- Focus on purpose, constraints, success criteria, and non-goals.",
    "- If progress is blocked by missing evidence, state the research gap before continuing.",
    "",
    "### Phase 3: Diverge, then propose 2-3 approaches",
    "- Explore a wider option set first; internally consider 5-7 directions before presenting finalists.",
    "- Pressure-test the space with one opposite option, one simplification/removal option, and one analogy/cross-domain option.",
    "- Name traps directly when they appear: solutioning too early, one-idea brainstorm, analysis paralysis.",
    "- Present only the strongest 2-3 viable approaches with trade-offs.",
    "- Lead with your recommended option and explain why.",
    "- For the leading option, call out the biggest unknown and the cheapest validation step.",
    "- Wait for the user to choose before moving on.",
    "",
    "### Phase 4: Present the design incrementally",
    "- Cover architecture, components, data flow, error handling, and testing.",
    "- Scale depth to complexity; keep simple sections short and nuanced sections concrete.",
    "- Validate each section with the user before advancing.",
    "- Apply YAGNI ruthlessly and prefer isolated units with clear boundaries.",
    "",
    "### Phase 5: Write the design doc",
    "- After the user approves the design, write `.omp/supipowers/specs/YYYY-MM-DD-<topic>-design.md`.",
    "- Use concise, implementation-ready language.",
    "- Keep the design doc local; do NOT commit it to git.",
    "",
    "### Phase 6: Run the spec review loop",
    "- Dispatch a spec-document-reviewer sub-agent with this prompt:",
    "",
    "```text",
    specReviewerPrompt,
    "```",
    "",
    "- Replace `<path-to-spec-file>` with the actual spec path.",
    "- If issues are found, fix the spec and re-run the reviewer.",
    "- Repeat until approved or you hit 5 iterations, then surface it to the user.",
    "",
    "### Phase 7: User review gate",
    "- After the spec review loop passes, ask the user to review the spec before planning implementation.",
    "- If they request changes, update the spec and re-run the spec review loop.",
    "- Proceed only after explicit user approval.",
    "",
    "### Phase 8: Write the implementation plan",
    "- Once the user approves the spec, follow these plan-writing instructions:",
    "",
    "```text",
    planWriterPrompt,
    "```",
    "",
    "- Replace `<path-to-approved-spec>` with the approved spec path.",
    "- After saving the plan, stop and wait. The approval UI handles execution handoff.",
    "",
    "## Planning Principles",
    "",
    "- One question at a time.",
    "- Multiple-choice is preferred when it speeds decisions.",
    "- Diverge broadly, converge tightly.",
    "- Keep brainstorming output concise: surface finalists, not every explored branch.",
    "- Name research gaps instead of faking certainty.",
    "- Decompose oversized scope before planning implementation.",
    "- Prefer clear interfaces, smaller units, and maintainable boundaries.",
    "- Keep the user informed about assumptions, trade-offs, open decisions, and validation steps.",
    ...buildAdditionalGuidelines(options.skillContent),
  ].join("\n");
}

function buildQuickPlanningSection(options: PlanningSystemPromptOptions): string {
  return [
    "═══════════Planning Mode═══════════",
    "",
    "<planning-mode>",
    "You are in quick planning mode for `/supi:plan --quick`.",
    "Generate a concise implementation plan directly unless a missing detail would make the plan misleading.",
    "Keep the work in planning mode: no implementation, no edits, no execution.",
    ...buildTopicLine(options.topic),
    "</planning-mode>",
    "",
    "## HARD-GATE",
    "",
    "- Do NOT write production code, apply patches, or claim that you changed files.",
    "- Ask follow-up questions only when the task is too ambiguous to plan responsibly.",
    "- Your deliverable is a saved implementation plan, not executed work.",
    "",
    "## Quick Planning Workflow",
    "",
    "1. Inspect the relevant code and constraints.",
    "2. If the task is clear enough, skip brainstorming and go straight to task breakdown.",
    "3. Write a concise implementation plan as markdown with YAML frontmatter:",
    "",
    "```yaml",
    "---",
    "name: <feature-name>",
    "created: YYYY-MM-DD",
    "tags: [tag1, tag2]",
    "---",
    "```",
    "",
    "4. Each task must include name, files, criteria, and complexity (small/medium/large).",
    "5. Save the plan under `.omp/supipowers/plans/YYYY-MM-DD-<feature-name>.md`.",
    "6. After saving, tell the user: `Plan saved to <path>. Review it and approve when ready.`",
    "7. Then stop and wait. The approval UI handles execution handoff.",
    ...buildAdditionalGuidelines(options.skillContent),
  ].join("\n");
}

function buildPlanningCriticalBlock(options: PlanningSystemPromptOptions): string {
  const lines = [
    "<critical>",
    "You are in `/supi:plan` planning mode.",
    "You **MUST NOT** implement code, apply patches, or act as though implementation already happened.",
    options.isQuick
      ? "You **MUST** produce a concise implementation plan and stop after saving it."
      : "You **MUST** follow the planning phases sequentially and stop after saving the implementation plan.",
    "Use tools to understand the repository, but keep all output oriented toward design and planning.",
    "When you need to ask the user a question with options, use the `planning_ask` tool — never `ask`.",
    "",
    "## Plan submission",
    "",
    "This is NOT native OMP plan mode.",
    "You **MUST NOT** call `exit_plan_mode` or `ExitPlanMode` — it will fail.",
    `You **MUST NOT** write plans to \`local://PLAN.md\` — that is OMP's native plan location and will not trigger the approval flow.`,
    `You **MUST** save the plan to \`${options.dotDirDisplay}/supipowers/plans/YYYY-MM-DD-<feature-name>.md\` using the Write tool.`,
    "After saving, tell the user the plan path, then **stop and yield your turn**.",
    "The approval UI appears automatically when your turn ends and a new plan file is detected in that directory.",
    "</critical>",
  ];

  return lines.join("\n");
}

export function buildPlanningSystemPrompt(
  basePrompt: string,
  options: PlanningSystemPromptOptions,
): string {
  let prompt = basePrompt;

  for (const tag of STRIP_TAGS) {
    prompt = stripTagSection(prompt, tag);
  }

  prompt = stripBetween(prompt, SKILLS_HEADER, TOOLS_HEADER);
  prompt = stripBetween(prompt, RULES_MARKER, NOW_MARKER);

  const planningSection = options.isQuick
    ? buildQuickPlanningSection(options)
    : buildFullPlanningSection(options);

  prompt = insertBeforeMarker(prompt, NOW_MARKER, planningSection);
  prompt = replaceNowCriticalBlock(prompt, buildPlanningCriticalBlock(options));

  return normalizePrompt(prompt);
}

export function registerPlanningSystemPromptHook(platform: Platform): void {
  platform.on("before_agent_start", (event, ctx) => {
    if (!isPlanningActive()) return;

    const debugLogger = getPlanningDebugLogger() ?? createDebugLogger(platform.paths, ctx as any, "plan");
    const options = getPlanningPromptOptions();
    const basePrompt = (event as any).systemPrompt as string | undefined;
    if (!options || !basePrompt) {
      debugLogger.log("system_prompt_override_skipped", {
        hasPlanningOptions: Boolean(options),
        hasBasePrompt: Boolean(basePrompt),
      });
      return;
    }

    const systemPrompt = buildPlanningSystemPrompt(basePrompt, options);
    debugLogger.log("system_prompt_override_applied", {
      replaced: systemPrompt !== basePrompt,
      hasPlanningModeMarker: systemPrompt.includes("Planning Mode"),
      basePromptLength: basePrompt.length,
      systemPromptLength: systemPrompt.length,
      systemPrompt,
    });

    return { systemPrompt };
  });
}
