/**
 * `/supi:harness` command dispatcher.
 *
 * Sub-commands:
 *  - bare entry (no args)        — detect installation; start guided setup or prompt harden/rebuild/cancel.
 *  - discover                    — run/advance the discover stage.
 *  - research                    — run/advance the research stage.
 *  - design                      — run/advance the design stage (requires Discover + Research).
 *  - plan-draft                  — render and persist the plan from the in-flight design spec.
 *  - implement                   — route plan to in-session steer or batch.
 *  - validate                    — run validate sub-checks.
 *  - resume                      — pick up in-flight session.
 *  - status                      — print stage + score badge.
 *  - gc                          — drain queue + drift report.
 *  - next                        — pop next unresolved entry.
 *  - resolve <id>                — mark entry resolved.
 *  - backlog                     — list every open entry.
 *  - score                       — recompute and print score.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Platform, PlatformPaths } from "../platform/types.js";
import { notifyError, notifyInfo } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { loadModelConfig } from "../config/model-config.js";
import { getProjectStatePath } from "../workspace/state-paths.js";
import { loadMarker, describeMarker, resolveBareEntry } from "./bare-entry.js";
import {
  backlog as readBacklog,
  next as nextQueueEntry,
  resolve as resolveQueueEntry,
} from "./anti_slop/queue.js";
import {
  listHarnessSessions,
  loadHarnessDesignSpecJson,
  loadHarnessDiscover,
  loadHarnessSession,
  loadHarnessValidateReport,
  readSlopQueue,
  saveHarnessSession,
} from "./storage.js";
import { computeScore } from "./anti_slop/score.js";
import {
  type BuildRunnerInput,
  type HarnessPipelineProgressEvent,
  type PipelineRunOutcome,
  HARNESS_STAGE_ORDER,
  runHarnessPipelineUntilGate,
} from "./pipeline.js";
import { defaultDesignSpecFromDiscover } from "./stages/design.js";
import { newHarnessSessionId } from "./stage-runner.js";
import { buildBackendAdapter } from "./anti_slop/backend-factory.js";
import { getWorkingTreeStatus } from "../git/status.js";
import { DEFAULT_HARNESS_CONFIG } from "./hooks/register.js";
import { handlePrComment } from "./pr-comment/handler.js";
import type { HarnessDesignSpec, HarnessGateMode, HarnessSession, HarnessStage } from "../types.js";

modelRegistry.register({
  id: "harness",
  category: "command",
  label: "Harness",
  harnessRoleHint: "plan",
});

export interface HarnessCommandContext {
  cwd: string;
  hasUI?: boolean;
  newSession?: (options?: any) => Promise<{ cancelled: boolean }>;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select?: (title: string, options: unknown[]) => Promise<string | null>;
    input?: (label: string) => Promise<string | null>;
  };
}

export const HARNESS_SUBCOMMANDS = [
  { name: "discover", description: "Run/advance the discover stage" },
  { name: "research", description: "Run/advance the research stage" },
  { name: "design", description: "Run/advance the design stage (requires Discover + Research)" },
  { name: "plan-draft", description: "Render and persist the plan from the in-flight design spec" },
  { name: "implement", description: "Route plan to in-session steer or batch" },
  { name: "docs", description: "Generate per-layer agent docs (extensive mode only)" },
  { name: "validate", description: "Run validate sub-checks" },
  { name: "resume", description: "Pick up an in-flight session" },
  { name: "status", description: "Print stage + score badge" },
  { name: "gc", description: "Drain queue + drift report" },
  { name: "next", description: "Pop the next unresolved queue entry" },
  { name: "resolve", description: "Mark a queue entry resolved" },
  { name: "backlog", description: "List every open queue entry" },
  { name: "score", description: "Recompute and display the score" },
  { name: "pr-comment", description: "Render or post the harness PR sticky comment" },
] as const;

type HarnessSubcommand = (typeof HARNESS_SUBCOMMANDS)[number]["name"];

const SUBCOMMAND_NAMES: Set<string> = new Set(HARNESS_SUBCOMMANDS.map((s) => s.name));

const HARNESS_STAGE_LABELS: Readonly<Record<HarnessStage, string>> = {
  discover: "Discover codebase",
  research: "Research topics",
  design: "Design harness",
  plan: "Draft plan",
  implement: "Apply artifacts",
  docs: "Generate per-layer docs",
  validate: "Validate results",
};


export function parseHarnessArgs(raw: string | undefined): HarnessCommandRequest {
  if (!raw || raw.trim().length === 0) return { subcommand: null, args: [] };
  const tokens = raw.trim().split(/\s+/);
  const head = tokens[0];
  if (SUBCOMMAND_NAMES.has(head)) {
    return { subcommand: head, args: tokens.slice(1) };
  }
  return { subcommand: null, args: tokens };
}

export interface HarnessCommandRequest {
  subcommand: string | null;
  args: string[];
}

// ── Progress (status-bar + one final notification) ───────────────

function createHarnessProgress(ctx: HarnessCommandContext) {
  const SO = ["discover", "research", "design", "plan", "implement", "docs", "validate"] as HarnessStage[];
  let done = 0;
  let cur: HarnessStage | null = null;
  const completed: string[] = [];

  function refresh() {
    const label = cur ? HARNESS_STAGE_LABELS[cur] : "Complete";
    const spinner = cur ? "\u25cc" : "\u2713";
    (ctx.ui as any).setStatus?.("supi-harness", `  ${spinner} harness: ${label} (${done}/${SO.length})`);
  }
  refresh();

  return {
    onProgress(event: HarnessPipelineProgressEvent) {
      switch (event.type) {
        case "stage-started":
          cur = event.stage;
          break;
        case "stage-completed": {
          done += 1; cur = null;
          const mark = "\u2713";
          completed.push(`${mark} ${HARNESS_STAGE_LABELS[event.stage]}: ${event.detail || "done"}`);
          break;
        }
        case "stage-skipped":
          done += 1; cur = null;
          completed.push(`\u2013 ${HARNESS_STAGE_LABELS[event.stage]}: skipped`);
          break;
        case "awaiting-user":
          done += 1; cur = null;
          completed.push(`\u25cb ${HARNESS_STAGE_LABELS[event.stage]}: ${event.detail || "awaiting review"}`);
          break;
        case "stage-failed": case "stage-blocked":
          cur = null;
          completed.push(`\u2717 ${HARNESS_STAGE_LABELS[event.stage]}: ${event.detail || "failed"}`);
          break;
      }
      refresh();
    },
    summary(): string { return completed.join("\n"); },
    dispose() { (ctx.ui as any).setStatus?.("supi-harness", undefined); },
  };
}

function summarizeTrace(outcome: PipelineRunOutcome): string {
  const lines = outcome.trace.map((t) => {
    const label = HARNESS_STAGE_LABELS[t.stage];
    const mark = t.status === "completed" ? "\u2713" : t.status === "skipped" ? "\u2013" : t.status === "awaiting-user" ? "\u25cb" : "\u2717";
    return `  ${mark} ${label}: ${t.status}`;
  });
  const extra = outcome.message ? `\n  \u2192 ${outcome.message}` : "";
  return lines.join("\n") + extra;
}
// ── Top-level dispatcher ─────────────────────────────────────────

export async function handleHarness(
  platform: Platform,
  ctx: HarnessCommandContext,
  rawArgs?: string,
): Promise<void> {
  const request = parseHarnessArgs(rawArgs);
  try {
    switch (request.subcommand) {
      case null: await handleBareEntry(platform, ctx); return;
      case "status": await handleStatus(platform, ctx); return;
      case "score": await handleScore(platform, ctx); return;
      case "next": await handleNext(platform, ctx); return;
      case "resolve": await handleResolve(platform, ctx, request.args[0]); return;
      case "backlog": await handleBacklog(platform, ctx); return;
      case "gc": await handleGc(platform, ctx); return;
      case "discover": await handleStageCommand(platform, ctx, "discover", request.args); return;
      case "research": await handleStageCommand(platform, ctx, "research", request.args); return;
      case "design": await handleStageCommand(platform, ctx, "design", request.args); return;
      case "plan-draft": await handleStageCommand(platform, ctx, "plan", request.args); return;
      case "implement": await handleStageCommand(platform, ctx, "implement", request.args); return;
      case "docs": await handleStageCommand(platform, ctx, "docs", request.args); return;
      case "validate": await handleStageCommand(platform, ctx, "validate", request.args); return;
      case "resume": await handleResume(platform, ctx, request.args); return;
      case "pr-comment": await handlePrComment(platform, ctx, request.args); return;
      default:
        notifyError(ctx, "Unknown harness subcommand", `\`${request.subcommand}\` is not recognized.`);
        return;
    }
  } catch (error) {
    notifyError(ctx, "Harness command failed", error instanceof Error ? error.message : String(error));
  }
}

// ── Bare entry ────────────────────────────────────────────────────

async function runPipelineWithProgress(
  platform: Platform,
  ctx: HarnessCommandContext,
  sessionId: string,
  gates: HarnessGateMode,
  stageInputs: BuildRunnerInput,
  startStage?: HarnessStage,
): Promise<PipelineRunOutcome> {
  const harnessProgress = createHarnessProgress(ctx);
  const modelConfig = loadModelConfig(platform.paths, ctx.cwd);
  const outcome = await pipelineDriver({
    platform, paths: platform.paths, cwd: ctx.cwd, sessionId,
    modelConfig, gates, stageInputs, startStage,
    onProgress: harnessProgress.onProgress,
  });
  // Single consolidated notification.
  const body = harnessProgress.summary() || "(no stages executed)";
  if (outcome.status === "failed" || outcome.status === "blocked") {
    notifyError(ctx, "/supi:harness", body);
  } else {
    notifyInfo(ctx, "/supi:harness", body);
  }
  harnessProgress.dispose();
  return outcome;
}


// ── Rebuild gate loop ──────────────────────────────────────────────

function nextStageAfterGate(stage: HarnessStage): HarnessStage | undefined {
  const idx = HARNESS_STAGE_ORDER.indexOf(stage);
  return idx >= 0 && idx < HARNESS_STAGE_ORDER.length - 1
    ? HARNESS_STAGE_ORDER[idx + 1]
    : undefined;
}

async function presentGateForStage(
  stage: HarnessStage,
  platform: Platform,
  ctx: HarnessCommandContext,
  sessionId: string,
): Promise<"continue" | "stop"> {
  if (!ctx.ui.select) return "continue";

  switch (stage) {
    case "discover": {
      const d = loadHarnessDiscover(platform.paths, ctx.cwd, sessionId);
      const summary = d.ok
        ? `Languages: ${d.value.languages.join(", ")}\nRecommended backend: ${d.value.recommendedBackend}`
        : "(unable to load discover artifact)";
      const choice = await ctx.ui.select(
        `Discover findings\n\n${summary}\n\nContinue to research + design?`,
        ["Continue", "Stop"],
      );
      return choice === "Continue" ? "continue" : "stop";
    }
    case "design": {
      const spec = loadHarnessDesignSpecJson(platform.paths, ctx.cwd, sessionId);
      const backend = spec.ok ? spec.value.antiSlop.backend : "?";
      const layers = spec.ok ? spec.value.layerRules.length : 0;
      const principles = spec.ok ? spec.value.goldenPrinciples.length : 0;
      const summary = `Backend: ${backend}\nLayer rules: ${layers}\nGolden principles: ${principles}\n\nThe design spec has been auto-derived from your codebase. You can edit it at:\n  <session>/design-spec.json`;
      const choice = await ctx.ui.select(
        `Design spec ready\n\n${summary}\n\nContinue to plan?`,
        ["Continue", "Stop — I'll customize the design"],
      );
      if (choice !== "Continue") return "stop";
      return await promptDocsTierIfNeeded(platform, ctx, sessionId, layers);
    }
    case "plan": {
      const plansDir = getProjectStatePath(platform.paths, ctx.cwd, "plans");
      const planPath = path.join(plansDir, `harness-${sessionId}.md`);
      let taskCount = 0;
      if (fs.existsSync(planPath)) {
        const content = fs.readFileSync(planPath, "utf8");
        taskCount = (content.match(/^### Task \d+:/gm) || []).length;
      }
      const summary = `${taskCount} tasks drafted.\n\nPlan: ${planPath}`;
      const choice = await ctx.ui.select(
        `Plan draft\n\n${summary}\n\nApprove and apply?`,
        ["Approve and continue", "Stop — I need to review the plan"],
      );
      return choice === "Approve and continue" ? "continue" : "stop";
    }
    case "docs": {
      const session = loadHarnessSession(platform.paths, ctx.cwd, sessionId);
      const tier = session.ok ? (session.value.docsTier ?? "simple") : "simple";
      const docsDir = path.join(ctx.cwd, "docs", "layers");
      let layerCount = 0;
      if (fs.existsSync(docsDir)) {
        try {
          layerCount = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md")).length;
        } catch {
          /* best-effort */
        }
      }
      const summary = tier === "extensive"
        ? `Tier: extensive\nPer-layer docs at docs/layers/ (${layerCount} layer file${layerCount === 1 ? "" : "s"}).\nIndex: docs/README.md.`
        : `Tier: simple\nNo per-layer docs were generated.`;
      const choice = await ctx.ui.select(
        `Per-layer agent docs\n\n${summary}\n\nContinue to validate?`,
        ["Continue", "Stop — I want to inspect the docs first"],
      );
      return choice === "Continue" ? "continue" : "stop";
    }
    case "validate": {
      const report = loadHarnessValidateReport(platform.paths, ctx.cwd, sessionId);
      const passed = report.ok ? report.value.passed : false;
      const score = report.ok ? report.value.score.lenient : "?";
      const findingCount = report.ok
        ? report.value.checks.reduce((sum, c) => sum + c.findings.length, 0)
        : 0;
      const summary = `Passed: ${passed}\nScore (lenient): ${score}\nFindings: ${findingCount}`;
      const choice = await ctx.ui.select(
        `Validation ${passed ? "passed" : "found issues"}\n\n${summary}\n\nAccept results?`,
        ["Accept", "Reject — I'll fix issues first"],
      );
      return choice === "Accept" ? "continue" : "stop";
    }
    default:
      return "continue";
  }
}

/**
 * Ask the user whether the upcoming docs stage should generate per-layer agent docs.
 *
 * Behavior:
 *   - If the session manifest already records a `docsTier`, skip the prompt.
 *   - In `auto` gate mode (no UI), default to "simple" silently.
 *   - In default/manual modes, prompt the user; "cancel" aborts via `stop` propagated
 *     by the caller; "simple"/"extensive" persist on the manifest.
 *
 * Layer count <2 always resolves to "simple" — extensive mode is meaningless with a
 * single-bucket architecture.
 */
async function promptDocsTierIfNeeded(
  platform: Platform,
  ctx: HarnessCommandContext,
  sessionId: string,
  layerCount: number,
): Promise<"continue" | "stop"> {
  const session = loadHarnessSession(platform.paths, ctx.cwd, sessionId);
  if (!session.ok) return "continue";
  const isRerun =
    session.value.reRunMode === "rebuild" || session.value.reRunMode === "harden";
  if (session.value.docsTier && !isRerun) return "continue";

  let tier: "simple" | "extensive" = session.value.docsTier ?? "simple";
  if (layerCount >= 2 && ctx.ui.select) {
    const currentLabel = session.value.docsTier ? ` (current: ${session.value.docsTier})` : "";
    const summary = `simple    — Tier 1 docs only (AGENTS.md, architecture.md, golden-principles.md)\nextensive — Tier 1 + per-layer docs at docs/layers/<id>.md + index at docs/README.md\n              (≤150 LOC/doc, ${layerCount} layers detected → ~${layerCount} subagent calls)`;
    const choice = await ctx.ui.select(
      `Generate per-layer agent docs in the upcoming Docs stage?${currentLabel}\n\n${summary}\n\nPick a tier:`,
      ["simple", "extensive"],
    );
    // `ctx.ui.select` returns `null` when the user cancels. Per the function doc, cancel
    // aborts the gate — we must NOT silently coerce that to "simple" and persist it.
    if (choice == null) return "stop";
    tier = choice === "extensive" ? "extensive" : "simple";
  }

  saveHarnessSession(platform.paths, ctx.cwd, {
    ...session.value,
    docsTier: tier,
    updatedAt: nowIso(),
  });
  notifyInfo(ctx, `Docs tier set: ${tier}`, tier === "extensive"
    ? `Per-layer docs will be generated for ${layerCount} layers.`
    : "Tier 1 docs only. Re-run /supi:harness design and choose 'extensive' to enable per-layer docs.");
  return "continue";
}

interface DesignAnalysisOutput {
  layerArchitecture: "single" | "two" | "three" | "custom";
  customLayerNames?: string[];
  goldenPrinciples: string[];
  tasteInvariants: string[];
}

function buildDesignAnalysisPrompt(discover: { languages: string[]; frameworks: string[]; packageManagers: string[]; buildTools: string[]; testTools: string[]; lintTools: string[]; monorepoShape: string; recommendedBackend: string }): string {
  const facts = [
    `Languages: ${discover.languages.join(", ") || "(none detected)"}`,
    `Frameworks: ${discover.frameworks.join(", ") || "(none detected)"}`,
    `Package manager: ${discover.packageManagers.join(", ") || "(none detected)"}`,
    `Build tools: ${discover.buildTools.join(", ") || "(none detected)"}`,
    `Test tools: ${discover.testTools.join(", ") || "(none detected)"}`,
    `Lint tools: ${discover.lintTools.join(", ") || "(none detected)"}`,
    `Repo shape: ${discover.monorepoShape}`,
  ].join("\n");

  const langHints = discover.languages.includes("typescript") || discover.languages.includes("tsx")
    ? "\nFor TypeScript codebases, good principles include:\n" +
      '- "Every exported function has an explicit return type"\n' +
      '- "No `as any` casts in production code"\n' +
      '- "Imports are sorted: built-ins \u2192 external \u2192 internal"\n' +
      '- "Error boundaries at every async boundary"'
    : "";

  return `You are configuring a coding harness for a codebase. Suggest a complete design configuration. You MUST provide at least 3 golden principles and at least 1 taste invariant — even for simple projects there are always mechanical rules worth enforcing.

Codebase facts:
${facts}${langHints}

Respond with ONLY a JSON object (no markdown fences, no explanation):
{
  "layerArchitecture": "single" | "two" | "three" | "custom",
  "customLayerNames": ["name1", "name2"],
  "goldenPrinciples": ["Rule 1", "Rule 2", "Rule 3"],
  "tasteInvariants": ["Rule 1"]
}

RULES (follow strictly):
- goldenPrinciples: 3-10 mechanical rules an AI coding agent must follow. Every project has at least 3: type safety, error handling, and code organization. Be specific to the detected languages and tools.
- tasteInvariants: 1-8 style/format rules that tooling can check. Every project has at least 1: consistent naming or import ordering.
- layerArchitecture: use "single" for small projects, "two" for lib+app, "three" for domain/app/infra patterns. Prefer "two" when a package.json suggests a build step.
- NEVER return empty arrays. If unsure, use the examples as defaults.

Output ONLY the JSON.`;
}

async function spawnDesignAnalysisSubagent(
  platform: Platform,
  cwd: string,
  sessionId: string,
): Promise<DesignAnalysisOutput | null> {
  const discover = loadHarnessDiscover(platform.paths, cwd, sessionId);
  if (!discover.ok) return null;

  const prompt = buildDesignAnalysisPrompt(discover.value);

  let session: Awaited<ReturnType<Platform["createAgentSession"]>> | null = null;
  try {
    session = await platform.createAgentSession({
      cwd,
      agentId: `harness-design-analyze-${sessionId}`,
      agentDisplayName: "harness-design-analyze",
    });
    await session.prompt(prompt, { expandPromptTemplates: false });

    // Extract the last assistant message.
    const messages = session.state.messages as Array<{ role?: string; content?: unknown }>;
    let lastText = "";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.role === "assistant" && msg.content) {
        const content = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("")
            : "";
        lastText = content.trim();
        if (lastText) break;
      }
    }

    if (!lastText) return null;

    // Strip markdown fences and parse JSON.
    const jsonText = lastText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(jsonText) as DesignAnalysisOutput;

    // Validate basic shape.
    if (!parsed.layerArchitecture || !Array.isArray(parsed.goldenPrinciples) || !Array.isArray(parsed.tasteInvariants)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  } finally {
    if (session) {
      try { await session.dispose(); } catch { /* best-effort */ }
    }
  }
}


async function runDesignQa(
  platform: Platform,
  ctx: HarnessCommandContext,
  sessionId: string,
): Promise<HarnessDesignSpec> {
  const discover = loadHarnessDiscover(platform.paths, ctx.cwd, sessionId);
  const base: HarnessDesignSpec = discover.ok
    ? defaultDesignSpecFromDiscover(discover.value, sessionId, new Date().toISOString())
    : {
        sessionId,
        recordedAt: new Date().toISOString(),
        layerRules: [] as HarnessDesignSpec["layerRules"],
        tasteInvariants: [] as string[],
        tooling: { lint: null, structuralTest: null, eval: null } as HarnessDesignSpec["tooling"],
        goldenPrinciples: [] as string[],
        docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
        validationGates: [],
        ci: {
          provider: "github-actions",
          trigger: { mode: "branches", branches: ["dev", "main"] },
          localCommand: "bun run harness:quality",
          workflowPath: ".github/workflows/harness-quality.yml",
        },
        supipowersWiring: { addReviewAgent: true, wireChecksGate: false },
        antiSlop: {
          backend: "fallow" as HarnessDesignSpec["antiSlop"]["backend"],
          hooks: DEFAULT_HARNESS_CONFIG.anti_slop,
          skillTargets: [],
        },
      };

  if (!ctx.ui.select) return base;

  // ── Spawn subagent to pre-fill design suggestions ──
  notifyInfo(ctx, "Analyzing codebase", "Spawning design analysis subagent…");
  const analysis = await spawnDesignAnalysisSubagent(platform, ctx.cwd, sessionId);

  if (analysis && ctx.ui.select) {
    // Ensure the subagent didn't return empty arrays.
    sanitizeAnalysisDefaults(analysis, discover.ok ? discover.value.languages : []);

    // Build a summary of the subagent's suggestions.
    const layerLabel =
      analysis.layerArchitecture === "single" ? "Single-bucket — no layer enforcement" :
      analysis.layerArchitecture === "two" ? "Two-layer (lib + app)" :
      analysis.layerArchitecture === "three" ? "Three-layer (domain / application / infrastructure)" :
      analysis.customLayerNames?.length ? `Custom: ${analysis.customLayerNames.join(", ")}` :
      "Custom";

    const summary = [
      `Layer architecture: ${layerLabel}`,
      `Golden principles (${analysis.goldenPrinciples.length}):`,
      ...analysis.goldenPrinciples.map((p) => `  • ${p}`),
      `Taste invariants (${analysis.tasteInvariants.length}):`,
      ...analysis.tasteInvariants.map((p) => `  • ${p}`),
    ].join("\n");

    const choice = await ctx.ui.select(
      `Design suggestions\n\n${summary}\n\nUse these suggestions?`,
      ["Accept all suggestions", "Edit each section manually", "Skip — use bare defaults"],
    );

    if (choice === "Accept all suggestions") {
      applyDesignAnalysis(base, analysis);
      await askCiAndTooling(ctx, base);
      return base;
    }

    if (choice === "Skip — use bare defaults") {
      await askCiAndTooling(ctx, base);
      return base;
    }
  }

  // ── Manual Q&A (fallback when subagent fails or user chooses to edit) ──
  const layerChoice = await ctx.ui.select(
    "Design: how is your codebase layered?",
    [
      "Single-bucket — no layer enforcement",
      "Two-layer (e.g., shared lib + app code)",
      "Three-layer (domain / application / infrastructure)",
      "Custom — I'll describe each layer",
    ],
  );

  if (layerChoice === "Custom — I'll describe each layer" && ctx.ui.input) {
    const raw = await ctx.ui.input(
      "Enter layer names, comma-separated (e.g., 'ui, domain, data'):",
    );
    if (raw) {
      const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
      base.layerRules = names.map((name) => ({
        layer: name,
        globs: [`src/${name}/**`],
        allowedImports: [] as string[],
        forbiddenImports: [] as string[],
      }));
    }
  } else if (layerChoice?.startsWith("Two-layer")) {
    base.layerRules = [
      { layer: "lib", globs: ["src/lib/**"], allowedImports: [], forbiddenImports: [] },
      { layer: "app", globs: ["src/app/**"], allowedImports: ["lib"], forbiddenImports: [] },
    ];
  } else if (layerChoice?.startsWith("Three-layer")) {
    base.layerRules = [
      { layer: "domain", globs: ["src/domain/**"], allowedImports: [], forbiddenImports: [] },
      { layer: "application", globs: ["src/application/**"], allowedImports: ["domain"], forbiddenImports: [] },
      { layer: "infrastructure", globs: ["src/infrastructure/**"], allowedImports: ["domain", "application"], forbiddenImports: [] },
    ];
  }

  // ── Q2: Golden principles ──
  if (ctx.ui.input) {
    const raw = await ctx.ui.input(
      "Golden principles — one per line, empty to skip:\n" +
      "Examples: 'Never throw raw errors', 'Every module exports a contract', 'Tests before implementation'",
    );
    if (raw) {
      base.goldenPrinciples = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    }
  }

  // ── Q3: Taste invariants ──
  if (ctx.ui.input) {
    const raw = await ctx.ui.input(
      "Taste invariants — one per line, empty to skip:\n" +
      "Examples: 'No files over 200 lines', 'Functions max 4 params', 'No console.log in production'",
    );
    if (raw) {
      base.tasteInvariants = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    }
  }

  await askCiAndTooling(ctx, base);
  return base;
}

function applyDesignAnalysis(spec: HarnessDesignSpec, analysis: DesignAnalysisOutput): void {
  switch (analysis.layerArchitecture) {
    case "two":
      spec.layerRules = [
        { layer: "lib", globs: ["src/lib/**"], allowedImports: [], forbiddenImports: [] },
        { layer: "app", globs: ["src/app/**"], allowedImports: ["lib"], forbiddenImports: [] },
      ];
      break;
    case "three":
      spec.layerRules = [
        { layer: "domain", globs: ["src/domain/**"], allowedImports: [], forbiddenImports: [] },
        { layer: "application", globs: ["src/application/**"], allowedImports: ["domain"], forbiddenImports: [] },
        { layer: "infrastructure", globs: ["src/infrastructure/**"], allowedImports: ["domain", "application"], forbiddenImports: [] },
      ];
      break;
    case "custom":
      if (analysis.customLayerNames?.length) {
        spec.layerRules = analysis.customLayerNames.map((name) => ({
          layer: name,
          globs: [`src/${name}/**`],
          allowedImports: [],
          forbiddenImports: [],
        }));
      }
      break;
    // "single" — leave layerRules empty
  }

  spec.goldenPrinciples = analysis.goldenPrinciples.slice(0, 10);
  spec.tasteInvariants = analysis.tasteInvariants.slice(0, 8);
}

function sanitizeAnalysisDefaults(analysis: DesignAnalysisOutput, languages: string[]): void {
  const isTS = languages.some((l) => l === "typescript" || l === "tsx");

  if (analysis.goldenPrinciples.length === 0) {
    analysis.goldenPrinciples = isTS
      ? [
          "Every exported function has an explicit return type",
          "No `as any` casts in production code",
          "Error boundaries at every async boundary — never let a promise reject unhandled",
        ]
      : [
          "Every function handles its error path explicitly",
          "No dead code — remove unused imports, variables, and functions",
          "Tests exist for every public API before merging",
        ];
  }

  if (analysis.tasteInvariants.length === 0) {
    analysis.tasteInvariants = isTS
      ? [
          "Imports sorted: built-ins, then external packages, then internal modules",
          "Consistent naming: camelCase for variables, PascalCase for types and classes",
        ]
      : [
          "Imports are grouped and sorted alphabetically",
          "Consistent naming conventions across the codebase",
        ];
  }
}

function localCommandOptions(base: HarnessDesignSpec): string[] {
  const command = base.ci.localCommand;
  const manager = command.split(/\s+/)[0] || "bun";
  const runPrefix = manager === "npm" ? "npm run" : manager;
  const ciCommand = manager === "npm" ? "npm run ci" : `${runPrefix} ci`;
  const checkCommand = manager === "npm" ? "npm run check" : `${runPrefix} check`;
  return Array.from(new Set([
    `${command} (recommended — dedicated harness quality command)`,
    `${ciCommand} (reuse existing CI script if present)`,
    `${checkCommand} (reuse existing check script if present)`,
    "Custom command",
  ]));
}

async function askCiAndTooling(ctx: HarnessCommandContext, base: HarnessDesignSpec): Promise<void> {
  if (!ctx.ui.select) return;

  const triggerChoice = await ctx.ui.select(
    "CI trigger: when should harness quality checks run?",
    [
      "Only PRs to dev and main (recommended)",
      "All pull requests",
      "Only PRs to main",
      "Custom target branches",
    ],
  );
  if (triggerChoice === "All pull requests") {
    base.ci.trigger = { mode: "all-prs" };
  } else if (triggerChoice === "Only PRs to main") {
    base.ci.trigger = { mode: "branches", branches: ["main"] };
  } else if (triggerChoice === "Custom target branches" && ctx.ui.input) {
    const raw = await ctx.ui.input("Target branches for CI, comma-separated:");
    const branches = raw?.split(",").map((branch) => branch.trim()).filter(Boolean) ?? [];
    if (branches.length > 0) base.ci.trigger = { mode: "branches", branches };
  } else {
    base.ci.trigger = { mode: "branches", branches: ["dev", "main"] };
  }

  const toolChoice = await ctx.ui.select(
    "Local validation command CI should call",
    localCommandOptions(base),
  );
  if (toolChoice === "Custom command" && ctx.ui.input) {
    const custom = await ctx.ui.input("Local command CI should run:");
    if (custom?.trim()) base.ci.localCommand = custom.trim();
  } else if (toolChoice) {
    base.ci.localCommand = toolChoice.replace(/\s+\(.+\)$/, "");
  }
}



async function runRebuildWithGates(
  platform: Platform,
  ctx: HarnessCommandContext,
  sessionId: string,
): Promise<void> {
  let startStage: HarnessStage | undefined = undefined;
  let stageInputs: BuildRunnerInput = {};

  while (true) {
    const outcome = await runPipelineWithProgress(
      platform, ctx, sessionId, "default", stageInputs, startStage,
    );

    if (outcome.promoted) {
      notifyInfo(ctx, "Harness rebuild complete", "All stages passed.");
      return;
    }

    if (outcome.status === "failed" || outcome.status === "blocked") {
      return; // runPipelineWithProgress already notified the error
    }

    // ── Discover gate: present findings, then run design Q&A ──
    if (outcome.stage === "discover") {
      const choice = await presentGateForStage(outcome.stage, platform, ctx, sessionId);
      if (choice === "stop") {
        notifyInfo(ctx, "Harness rebuild paused", "Stopped at discover. Run /supi:harness research to continue.");
        return;
      }
      // Run design Q&A and feed the custom spec to the design stage.
      const customSpec = await runDesignQa(platform, ctx, sessionId);
      stageInputs = { designInput: { spec: customSpec } };
      // Advance to research (runs automatically, then design uses the custom spec).
      startStage = "research";
      continue;
    }

    // ── Design gate: show the resulting spec, clear design input ──
    if (outcome.stage === "design") {
      const choice = await presentGateForStage(outcome.stage, platform, ctx, sessionId);
      if (choice === "stop") {
        notifyInfo(ctx, "Harness rebuild paused", "Stopped at design. Run /supi:harness plan-draft to continue.");
        return;
      }
      stageInputs = {}; // design spec already persisted
      startStage = nextStageAfterGate(outcome.stage);
      if (!startStage) { notifyInfo(ctx, "Harness rebuild complete", ""); return; }
      continue;
    }

    // ── Other gates (plan, validate): standard gate UI ──
    const choice = await presentGateForStage(outcome.stage, platform, ctx, sessionId);
    if (choice === "stop") {
      const next = nextStageAfterGate(outcome.stage);
      const hint = next ? `Run /supi:harness ${next} to continue.` : "";
      notifyInfo(ctx, "Harness rebuild paused", `Stopped at ${outcome.stage}. ${hint}`);
      return;
    }

    startStage = nextStageAfterGate(outcome.stage);
    if (!startStage) {
      notifyInfo(ctx, "Harness rebuild complete", "All stages passed.");
      return;
    }
  }
}

async function handleBareEntry(platform: Platform, ctx: HarnessCommandContext): Promise<void> {
  const marker = loadMarker(platform.paths, ctx.cwd);

  // ── Pre-flight: verify git tree is clean ──
  const status = await getWorkingTreeStatus(
    (cmd, args, opts) => platform.exec(cmd, args, opts),
    ctx.cwd,
  );
  if (status.dirty) {
    const fileList = status.files.slice(0, 10).join("\n  ");
    const more = status.files.length > 10 ? `\n  ...and ${status.files.length - 10} more` : "";
    notifyError(ctx, "/supi:harness blocked",
      `Working tree is dirty (${status.files.length} file(s)). Commit or stash changes first.\n\nDirty files:\n  ${fileList}${more}`,
    );
    return;
  }

  // ── Fresh install (guided only) ──
  if (!marker) {
    if (!ctx.ui.select) {
      notifyInfo(ctx, "No harness installed", "Run `/supi:harness discover` to begin guided setup.");
      return;
    }
    const sessionId = newHarnessSessionId();
    const p = saveHarnessSession(platform.paths, ctx.cwd, freshSession(sessionId, ctx.cwd, "discover"));
    if (!p.ok) { notifyError(ctx, "/supi:harness", p.error.message); return; }
    notifyInfo(ctx, "Harness guided setup", `Starting guided setup (session ${sessionId})...`);
    await runRebuildWithGates(platform, ctx, sessionId);
    return;
  }

  if (!ctx.ui.select) {
    notifyInfo(ctx, "Harness already installed", describeMarker(marker));
    return;
  }

  const decision = await resolveBareEntry({
    paths: platform.paths, cwd: ctx.cwd,
    prompt: async (opts) => {
      const labels = opts.choices.map((c) => c.label);
      const s = await ctx.ui.select!(opts.title, labels as unknown as string[]);
      if (s === null || s === undefined) return null;
      const idx = labels.indexOf(s);
      return idx >= 0 ? opts.choices[idx].value : null;
    },
  });

  if (decision.kind !== "rerun") {
    notifyError(ctx, "/supi:harness", "Harness marker disappeared before rerun selection could be applied.");
    return;
  }

  if (decision.mode === "cancel") {
    notifyInfo(ctx, "Harness rerun cancelled", "No changes made.");
    return;
  }

  const existingSessions = listHarnessSessions(platform.paths, ctx.cwd);
  const sessionId =
    decision.mode === "harden" && existingSessions.length > 0 ? existingSessions[0] : newHarnessSessionId();

  if (sessionId !== existingSessions[0]) {
    const p = saveHarnessSession(platform.paths, ctx.cwd, freshSession(sessionId, ctx.cwd, "discover"));
    if (!p.ok) { notifyError(ctx, "/supi:harness", p.error.message); return; }
  }

  // Persist the rerun mode so downstream gate prompts can adapt (e.g. Docs tier
  // re-prompts on rebuild with the stored value as the default).
  const existingSession = loadHarnessSession(platform.paths, ctx.cwd, sessionId);
  if (existingSession.ok) {
    saveHarnessSession(platform.paths, ctx.cwd, {
      ...existingSession.value,
      reRunMode: decision.mode,
      updatedAt: nowIso(),
    });
  }

  const modeLabel = decision.mode === "harden" ? "Gap-fill" : "Full rebuild";
  notifyInfo(ctx, `Harness ${decision.mode}`, `${modeLabel} (session ${sessionId}) — pipeline running...`);

  if (decision.mode === "harden") {
    // Harden: no gates between stages. Re-prompt the docs tier so users can promote
    // `simple` → `extensive` without forcing a full rebuild (only meaningful with ≥2
    // layer rules). The pipeline then runs end-to-end including implement (programmatic
    // apply) → docs → validate inside the same `/supi:harness` invocation.
    const designSpec = loadHarnessDesignSpecJson(platform.paths, ctx.cwd, sessionId);
    const layerCount = designSpec.ok ? designSpec.value.layerRules.length : 0;
    if (layerCount >= 2) {
      await promptDocsTierIfNeeded(platform, ctx, sessionId, layerCount);
    }
    await runPipelineWithProgress(platform, ctx, sessionId, "auto", {});
  } else {
    // Rebuild: full regeneration with user gates at each stage.
    await runRebuildWithGates(platform, ctx, sessionId);
  }
}

// ── Subcommand handlers ──────────────────────────────────────────

async function handleStatus(platform: Platform, ctx: HarnessCommandContext): Promise<void> {
  const marker = loadMarker(platform.paths, ctx.cwd);
  notifyInfo(ctx, "Harness status", describeMarker(marker));
  if (!marker) return;
  const q = readSlopQueue(platform.paths, ctx.cwd);
  if (q.ok) {
    const open = q.value.filter((e) => e.state === "open").length;
    const resolved = q.value.filter((e) => e.state === "resolved").length;
    notifyInfo(ctx, "Slop queue", `${open} open, ${resolved} resolved (total ${q.value.length})`);
  }
}

async function handleScore(platform: Platform, ctx: HarnessCommandContext): Promise<void> {
  const q = readSlopQueue(platform.paths, ctx.cwd);
  if (!q.ok) { notifyError(ctx, "Score unavailable", q.error.message); return; }
  const s = computeScore({ computedAt: new Date().toISOString(), entries: q.value });
  notifyInfo(ctx, "Harness score", `lenient ${s.lenient} / strict ${s.strict}`);
}

async function handleNext(platform: Platform, ctx: HarnessCommandContext): Promise<void> {
  const r = nextQueueEntry(platform.paths, ctx.cwd);
  if (!r.ok) { notifyError(ctx, "Queue read failed", r.error.message); return; }
  if (!r.value) { notifyInfo(ctx, "Slop queue empty", "Nothing to triage."); return; }
  const range = r.value.range ? `:${r.value.range.startLine}` : "";
  notifyInfo(ctx, `Next: ${r.value.id}`, `[${r.value.severity}] ${r.value.kind} at ${r.value.file}${range} — ${r.value.message}`);
}

async function handleResolve(platform: Platform, ctx: HarnessCommandContext, id: string | undefined): Promise<void> {
  if (!id) { notifyError(ctx, "Missing id", "Usage: /supi:harness resolve <id>"); return; }
  const r = resolveQueueEntry(platform.paths, ctx.cwd, id);
  if (!r.ok) { notifyError(ctx, "Resolve failed", r.error.message); return; }
  if (!r.value) { notifyError(ctx, "Resolve failed", `id ${id} not found in queue`); return; }
  notifyInfo(ctx, `Resolved ${id}`, `${r.value.kind} at ${r.value.file}`);
}

async function handleBacklog(platform: Platform, ctx: HarnessCommandContext): Promise<void> {
  const r = readBacklog(platform.paths, ctx.cwd);
  if (!r.ok) { notifyError(ctx, "Backlog read failed", r.error.message); return; }
  if (r.value.length === 0) { notifyInfo(ctx, "Backlog empty", "Queue has no open entries."); return; }
  const summary = r.value.slice(0, 10).map((e) =>
    `${e.id} ${e.severity.padEnd(7)} ${e.kind.padEnd(15)} ${e.file}`).join("\n");
  const more = r.value.length > 10 ? `\n…and ${r.value.length - 10} more.` : "";
  notifyInfo(ctx, `Backlog (${r.value.length})`, summary + more);
}

async function handleGc(_p: Platform, ctx: HarnessCommandContext): Promise<void> {
  notifyInfo(ctx, "/supi:harness gc",
    "v1 GC drives the queue via /supi:harness next + resolve. Auto-fix lands after /supi:harness design.");
}

// ── Registration ──────────────────────────────────────────────────

export function registerHarnessCommand(platform: Platform): void {
  platform.registerCommand("supi:harness", {
    description: "Install or maintain the harness pipeline.",
    getArgumentCompletions(prefix: string) {
      const lower = prefix.toLowerCase();
      const matches = HARNESS_SUBCOMMANDS
        .filter((sc) => sc.name.startsWith(lower))
        .map((sc) => ({ value: `${sc.name} `, label: sc.name, description: sc.description }));
      return matches.length > 0 ? matches : null;
    },
    async handler(args: string | undefined, ctx: HarnessCommandContext) {
      await handleHarness(platform, ctx, args);
    },
  });
}

// ── Per-stage subcommands ────────────────────────────────────────

type PipelineDriver = typeof runHarnessPipelineUntilGate;
let pipelineDriver: PipelineDriver = runHarnessPipelineUntilGate;

export function setHarnessPipelineDriver(d: PipelineDriver | null): void {
  pipelineDriver = d ?? runHarnessPipelineUntilGate;
}

const SID_PAT = /^harness-[0-9a-z]+-[0-9a-f]+$/;

function parseSessionFlag(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith("--session=")) return args[i].slice("--session=".length);
  }
  return null;
}

function nowIso(): string { return new Date().toISOString(); }
function projectName(cwd: string): string { return path.basename(cwd) || "harness"; }

function freshSession(id: string, cwd: string, stage: HarnessStage): HarnessSession {
  const ts = nowIso();
  return { sessionId: id, projectName: projectName(cwd), startedAt: ts, updatedAt: ts, stage,
    stageStatus: "pending", gateMode: "default", iteration: 1, blocker: null, artifacts: {} };
}

export interface ResolveSessionResult { sessionId: string; created: boolean; }

export function resolveHarnessSessionId(
  paths: PlatformPaths, cwd: string, args: string[],
  opts: { autoCreate: boolean; stage: HarnessStage },
): ResolveSessionResult | { error: string } {
  const ex = parseSessionFlag(args);
  if (ex) {
    if (!SID_PAT.test(ex)) return { error: `invalid session id "${ex}"` };
    return { sessionId: ex, created: false };
  }
  const existing = listHarnessSessions(paths, cwd);
  if (existing.length > 0) return { sessionId: existing[0], created: false };
  if (!opts.autoCreate) return { error: "no harness session found. Run /supi:harness discover first." };
  const id = newHarnessSessionId();
  const p = saveHarnessSession(paths, cwd, freshSession(id, cwd, opts.stage));
  if (!p.ok) return { error: `unable to persist: ${p.error.message}` };
  return { sessionId: id, created: true };
}

function buildStageInputs(
  paths: PlatformPaths, cwd: string, sid: string, stage: HarnessStage,
): { input: BuildRunnerInput } | { error: string } {
  switch (stage) {
    case "discover": case "research": case "plan": case "docs": return { input: {} };
    case "design": {
      const existing = loadHarnessDesignSpecJson(paths, cwd, sid);
      if (existing.ok) return { input: { designInput: { spec: existing.value } } };
      const d = loadHarnessDiscover(paths, cwd, sid);
      if (!d.ok) return { error: "design requires discover stage. Run /supi:harness discover first." };
      return { input: { designInput: { spec: defaultDesignSpecFromDiscover(d.value, sid, nowIso()) } } };
    }
    case "implement": {
      const plansDir = getProjectStatePath(paths, cwd, "plans");
      const planPath = path.join(plansDir, `harness-${sid}.md`);
      if (!fs.existsSync(planPath)) return { error: `implement requires plan at ${planPath}.` };
      return { input: { implementInput: { planPath, threshold: DEFAULT_HARNESS_CONFIG.implement_in_session_threshold ?? 10 } } };
    }
    case "validate": {
      const dr = loadHarnessDesignSpecJson(paths, cwd, sid);
      if (!dr.ok) return { error: "validate requires design. Run /supi:harness design first." };
      const s = dr.value;
      return { input: { validateInput: {
        backend: s.antiSlop.backend, adapter: buildBackendAdapter(s.antiSlop.backend) ?? undefined,
        scoreFloor: s.antiSlop.hooks.score_floor, hooks: s.antiSlop.hooks,
      } } };
    }
  }
}

function summarizeOutcome(o: PipelineRunOutcome): string {
  const t = o.message ? ` — ${o.message}` : "";
  return `stage=${o.stage} status=${o.status}${o.promoted ? " (promoted)" : ""}${t}`;
}

export async function handleStageCommand(
  platform: Platform, ctx: HarnessCommandContext, stage: HarnessStage, args: string[],
): Promise<void> {
  const res = resolveHarnessSessionId(platform.paths, ctx.cwd, args, { autoCreate: stage === "discover", stage });
  if ("error" in res) { notifyError(ctx, `/supi:harness ${stage}`, res.error); return; }
  const built = buildStageInputs(platform.paths, ctx.cwd, res.sessionId, stage);
  if ("error" in built) { notifyError(ctx, `/supi:harness ${stage}`, built.error); return; }
  if (res.created) notifyInfo(ctx, `Started session ${res.sessionId}`, `Fresh session for stage ${stage}.`);

  if (stage === "design" && !loadHarnessDesignSpecJson(platform.paths, ctx.cwd, res.sessionId).ok) {
    notifyInfo(ctx, "Using default design spec", "Edit <session>/design-spec.json to customize.");
  }

  await runPipelineWithProgress(platform, ctx, res.sessionId, "auto", built.input, stage);
}

async function handleResume(platform: Platform, ctx: HarnessCommandContext, args: string[]): Promise<void> {
  const explicit = parseSessionFlag(args);
  const sessions = listHarnessSessions(platform.paths, ctx.cwd);
  if (sessions.length === 0) { notifyInfo(ctx, "/supi:harness resume", "No sessions found."); return; }
  const target = explicit ?? sessions[0];
  const s = loadHarnessSession(platform.paths, ctx.cwd, target);
  if (!s.ok) { notifyError(ctx, "/supi:harness resume", `Unable to load ${target}: ${s.error.message}`); return; }
  const next = nextSubcommandFor(s.value.stage, s.value.stageStatus);
  notifyInfo(ctx, `Resume ${target}`, `stage=${s.value.stage} status=${s.value.stageStatus}. Run /supi:harness ${next}.`);
}

function nextSubcommandFor(stage: HarnessSession["stage"], status: HarnessSession["stageStatus"]): string {
  if (status === "awaiting-user" || status === "blocked") return cliNameFor(stage);
  switch (stage) {
    case "discover": return "research";
    case "research": return "design";
    case "design": return "plan-draft";
    case "plan": return "implement";
    case "implement": return "docs";
    case "docs": return "validate";
    case "validate": return "validate";
  }
}

function cliNameFor(stage: HarnessSession["stage"]): string {
  return stage === "plan" ? "plan-draft" : stage;
}
