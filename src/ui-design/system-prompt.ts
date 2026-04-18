import type { Platform } from "../platform/types.js";
import type { UiDesignBackendId, UiDesignScope } from "./types.js";
import { getActiveUiDesignSession, isUiDesignActive } from "./session.js";

export interface UiDesignSystemPromptOptions {
  skillContent?: string;
  subAgentTemplates?: { name: string; content: string }[];
  dotDirDisplay: string;
  topic?: string;
  scope?: UiDesignScope;
  contextScanSummary: string;
  sessionDir: string;
  companionUrl: string;
  backend: UiDesignBackendId;
}

const NOW_MARKER = "═══════════Now═══════════";
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
  return ["", `Initial design request: ${topic}`];
}

function buildAdditionalGuidelines(skillContent?: string): string[] {
  if (!skillContent) return [];
  return ["", "## Skill Content", "", skillContent.trim()];
}

function buildSubAgentTemplates(templates?: { name: string; content: string }[]): string[] {
  if (!templates || templates.length === 0) return [];
  const out: string[] = ["", "## Sub-agent prompt templates", ""];
  for (const { name, content } of templates) {
    out.push(`### \`${name}\``, "", "```text", content.trim(), "```", "");
  }
  return out;
}

function buildDirectorSection(options: UiDesignSystemPromptOptions): string {
  return [
    "═══Design Director═══",
    "",
    "<ui-design-mode>",
    "You are the Design Director for `/supi:ui-design`.",
    "Your output is a validated design artifact under the session directory.",
    "You do NOT write production code. You do NOT exit early. You follow the 9 Design Director phases in order.",
    ...buildTopicLine(options.topic),
    `Session directory: ${options.sessionDir}`,
    `Backend: ${options.backend}`,
    `Companion URL: ${options.companionUrl}`,
    "</ui-design-mode>",
    "",
    "## HARD-GATE",
    "",
    `- All file writes MUST happen inside \`${options.sessionDir}\`. Writing anywhere else is forbidden.`,
    "- You **MUST NOT** generate production code (`.ts`, `.tsx`, `.vue`, `.svelte`, `.py`) into the user's codebase.",
    "- You **MUST NOT** call `exit_plan_mode` or `ExitPlanMode` — completion is driven by the agent_end approval hook.",
    "- You **MUST NOT** use the `ask` tool. Use `planning_ask` for every user question.",
    "- You **MUST NOT** skip a phase. Each phase's precondition file MUST exist on disk before you advance.",
    "- You **MUST NOT** declare completion without updating `manifest.json`.",
    "",
    "## Context Scan Summary",
    "",
    options.contextScanSummary.trim(),
    "",
    "## Director state machine (9 model-owned phases)",
    "",
    "| # | Phase | Precondition | Output | Manifest status |",
    "|---|---|---|---|---|",
    "| 1 | Phase 1 — Scope selection | manifest.json with status=in-progress | planning_ask result → update manifest.scope | in-progress |",
    "| 2 | Phase 2 — Context review | manifest.scope populated | `<session>/context.md` | in-progress |",
    "| 3 | Phase 3 — Decomposition | `<session>/context.md` exists | `<session>/screen-decomposition.html` + `<session>/decomposition.json` | in-progress |",
    "| 4 | Phase 4 — Parallel components | `<session>/decomposition.json` exists | `<session>/components/<name>.html` + `<name>.tokens.json` | in-progress |",
    "| 5 | Phase 5 — Section assembly | all components present | `<session>/sections/<name>.html` | in-progress |",
    "| 6 | Phase 6 — Page composition | all sections present | `<session>/page.html` | critiquing |",
    "| 7 | Phase 7 — Design-critic pass | `<session>/page.html` exists | `<session>/critique.md` | awaiting-review |",
    "| 8 | Phase 8 — Fix loop (≤2) | `<session>/critique.md` exists | fixes in-place, critic re-run | awaiting-review |",
    "| 9 | Phase 9 — User review gate | fix loop terminated | `<session>/screen-review.html`; planning_ask → approve/request-changes/discard | complete or discarded |",
    "",
    "## Parallelism rules",
    "",
    "- Phase 4: parallel via a single `task` call with one sub-task per component.",
    "- Phase 5: serial. Later sections may reference earlier sections.",
    "- Phase 7: single sub-agent.",
    "",
    "## Filename collision prevention (Phase 3)",
    "",
    "Before writing `decomposition.json`, kebab-case every component name and assert `new Set(names).size === names.length`. On collision, disambiguate and re-check. Do **NOT** invoke `task` until the check passes.",
    "",
    "## Tool routing",
    "",
    "- `planning_ask` — every user question",
    "- `task` — all sub-agents (Phases 4, 5, 7); never `createAgentSession` directly",
    "- `read` / `write` / `edit` — session files only",
    ...buildAdditionalGuidelines(options.skillContent),
    ...buildSubAgentTemplates(options.subAgentTemplates),
  ].join("\n");
}

function buildCriticalBlock(options: UiDesignSystemPromptOptions): string {
  return [
    "<critical>",
    "You are in `/supi:ui-design` Design Director mode.",
    "You **MUST NOT** implement code, apply patches, or write outside the session directory.",
    "You **MUST** follow the 9 Design Director phases sequentially.",
    `All artifacts MUST be written under \`${options.sessionDir}\`.`,
    "When you need to ask the user a question with options, use the `planning_ask` tool — never `ask`.",
    "",
    "## Completion",
    "",
    "Completion is driven by `manifest.json`. Set `status: \"complete\"` + `approvedAt` only after the user approves via Phase 9's review gate.",
    "You **MUST NOT** call `exit_plan_mode`, `ExitPlanMode`, or write to `local://PLAN.md`.",
    "After updating the manifest to a terminal state, stop and yield your turn — the approval UI handles teardown.",
    "</critical>",
  ].join("\n");
}

export function buildUiDesignSystemPrompt(
  basePrompt: string,
  options: UiDesignSystemPromptOptions,
): string {
  let prompt = basePrompt;

  for (const tag of STRIP_TAGS) {
    prompt = stripTagSection(prompt, tag);
  }

  prompt = stripBetween(prompt, SKILLS_HEADER, TOOLS_HEADER);

  const directorSection = buildDirectorSection(options);
  prompt = insertBeforeMarker(prompt, NOW_MARKER, directorSection);
  prompt = replaceNowCriticalBlock(prompt, buildCriticalBlock(options));

  return normalizePrompt(prompt);
}

let activePromptOptions: UiDesignSystemPromptOptions | null = null;

export function setUiDesignPromptOptions(options: UiDesignSystemPromptOptions | null): void {
  activePromptOptions = options;
}

export function registerUiDesignSystemPromptHook(platform: Platform): void {
  platform.on("before_agent_start", (event: any, _ctx: any) => {
    if (!isUiDesignActive()) return;
    const basePrompt = event?.systemPrompt as string | undefined;
    if (!basePrompt || !activePromptOptions) {
      // No session prompt options captured — fall back to active session state
      const session = getActiveUiDesignSession();
      if (!session || !basePrompt) return;
      const fallback: UiDesignSystemPromptOptions = {
        dotDirDisplay: platform.paths.dotDirDisplay,
        sessionDir: session.dir,
        companionUrl: session.companionUrl,
        backend: session.backend,
        contextScanSummary: "Context scan summary unavailable. Read `context.md` if it exists.",
        topic: session.topic,
        scope: session.scope,
      };
      return { systemPrompt: buildUiDesignSystemPrompt(basePrompt, fallback) };
    }
    return { systemPrompt: buildUiDesignSystemPrompt(basePrompt, activePromptOptions) };
  });
}
