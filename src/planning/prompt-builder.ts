import { buildSpecReviewerPrompt } from "./spec-reviewer.js";
import { buildPlanWriterPrompt } from "./plan-writer-prompt.js";

export interface PlanningPromptOptions {
  topic?: string;
  skillContent?: string;
  dotDirDisplay: string;
}

/**
 * Build the comprehensive planning prompt that encodes the full brainstorming flow.
 * This is the steering prompt sent to the agent when `/supi:plan` runs.
 *
 * Follows supipowers' brainstorming skill flow:
 * 1. Explore project context
 * 2. Ask clarifying questions (one at a time)
 * 3. Propose 2-3 approaches with trade-offs
 * 4. Present design section by section
 * 5. Write design doc to .omp/supipowers/specs/
 * 6. Spec review loop (dispatch reviewer sub-agent)
 * 7. User review gate
 * 8. Handoff to implementation plan
 */
export function buildPlanningPrompt(options: PlanningPromptOptions): string {
  const { topic, skillContent, dotDirDisplay } = options;

  const sections: string[] = [
    "You are starting a collaborative planning session with the user.",
    "Follow this process step by step. Do NOT skip phases or combine them.",
    "",

    // ── Phase 1: Context ─────────────────────────────────────────
    "## Phase 1: Explore project context",
    "",
    "Before asking questions, understand the current project context:",
    "- Check files, docs, recent commits",
    "- Understand existing architecture and patterns",
    "- Assess scope: if the request describes multiple independent subsystems, flag it immediately and help decompose into sub-projects before proceeding",
    "",

    // ── Topic ────────────────────────────────────────────────────
    topic
      ? `The user wants to plan: ${topic}`
      : "Ask the user what they want to build or accomplish.",
    "",

    // ── Phase 2: Clarify ─────────────────────────────────────────
    "## Phase 2: Ask Clarifying Questions",
    "",
    "- Ask one question at a time — never overwhelm with multiple questions",
    "- Prefer **multiple choice** questions when possible, but open-ended is fine too",
    "- Focus on: purpose, constraints, success criteria",
    "- If a topic needs more exploration, break it into multiple questions",
    "- Continue until you have enough clarity to propose approaches",
    "",

    // ── Phase 3: Approaches ──────────────────────────────────────
    "## Phase 3: Propose 2-3 Approaches",
    "",
    "- Present 2-3 different approaches with trade-offs",
    "- Lead with your recommended option and explain why",
    "- Present options conversationally with your recommendation and reasoning",
    "- Wait for the user to choose before proceeding",
    "",

    // ── Phase 4: Design ──────────────────────────────────────────
    "## Phase 4: Present Design",
    "",
    "Once aligned on approach, present the design:",
    "- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced",
    "- Cover: architecture, components, data flow, error handling, testing",
    "- Ask after each section whether it looks right so far",
    "- Design for isolation and clarity: smaller units with clear boundaries",
    "- Apply YAGNI ruthlessly — remove unnecessary features",
    "- Be ready to go back and clarify if something doesn't make sense",
    "",

    // ── Phase 5: Write Spec ──────────────────────────────────────
    "## Phase 5: Write Design Doc",
    "",
    "Once the user approves the design:",
    "- Write the validated design doc to `.omp/supipowers/specs/YYYY-MM-DD-<topic>-design.md`",
    "- Use clear, concise writing",
    "- Commit the design document to git",
    "",

    // ── Phase 6: Spec Review Loop ────────────────────────────────
    "## Phase 6: Spec Review Loop",
    "",
    "After writing the design doc, dispatch a spec-document-reviewer sub-agent to verify it:",
    "",
    "1. Dispatch the reviewer with this prompt:",
    "",
    "```",
    buildSpecReviewerPrompt("<path-to-spec-file>"),
    "```",
    "",
    "(Replace `<path-to-spec-file>` with the actual spec path.)",
    "",
    "2. If **Issues Found**: fix the issues, re-dispatch the reviewer",
    "3. Repeat until **Approved** (max 5 iterations, then surface to human for guidance)",
    "",

    // ── Phase 7: User Gate ───────────────────────────────────────
    "## Phase 7: User Review Gate",
    "",
    "After the spec review loop passes, ask the user to review the spec before proceeding:",
    "",
    '> "Spec written and committed to `<path>`. Please review it and let me know if you want to make any changes before we start writing out the implementation plan."',
    "",
    "Wait for the user's response. If they request changes, make them and re-run the spec review loop. Only proceed once the user approves.",
    "",

    // ── Phase 8: Handoff ─────────────────────────────────────────
    "## Phase 8: Transition to Implementation Plan",
    "",
    "Once the user approves the spec, write a comprehensive implementation plan.",
    "Follow these plan writing instructions:",
    "",
    buildPlanWriterPrompt({ specPath: "<path-to-approved-spec>", dotDirDisplay }),
    "",
    "(Replace `<path-to-approved-spec>` with the actual spec file path from Phase 5.)",
    "",

    // ── Principles ───────────────────────────────────────────────
    "## Key Principles",
    "",
    "- **One question at a time** — Don't overwhelm with multiple questions",
    "- **Multiple choice preferred** — Easier to answer than open-ended when possible",
    "- **YAGNI ruthlessly** — Remove unnecessary features from all designs",
    "- **Explore alternatives** — Always propose 2-3 approaches before settling",
    "- **Incremental validation** — Present design, get approval before moving on",
    "- **Decompose large scope** — If the request covers multiple independent subsystems, decompose into sub-projects first",
    "- **Design for isolation** — Smaller units with clear boundaries and well-defined interfaces",
    "",
  ];

  if (skillContent) {
    sections.push("## Additional Planning Guidelines", "", skillContent, "");
  }

  return sections.join("\n");
}

/**
 * Build the quick plan prompt that skips brainstorming.
 * Used when `/supi:plan --quick <description>` is invoked.
 */
export function buildQuickPlanPrompt(
  description: string,
  skillContent?: string,
): string {
  const sections: string[] = [
    "Generate a concise implementation plan for the following task.",
    "Skip brainstorming — go straight to task breakdown.",
    "",
    `Task: ${description}`,
    "",
    "Format the plan as markdown with YAML frontmatter:",
    "",
    "```yaml",
    "---",
    "name: <feature-name>",
    "created: YYYY-MM-DD",
    "tags: [tag1, tag2]",
    "---",
    "```",
    "",
    "Each task should have: name, **files**, **criteria**, and **complexity** (small/medium/large).",
    "",
    "After generating the plan, save it and tell the user:",
    '> "Plan saved to `<path>`. Review it and approve when ready."',
    "Then stop and wait. The user will see an approval prompt.",
  ];

  if (skillContent) {
    sections.push("", "Follow these planning guidelines:", skillContent);
  }

  return sections.join("\n");
}
