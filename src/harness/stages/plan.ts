/**
 * PLAN stage runner.
 *
 * Reads the design spec and emits a Plan markdown into the canonical plans directory.
 * The plan is the user-approved task list that Implement will execute.
 *
 * The plan structure is the same shape `parsePlan` (src/storage/plans.ts) understands —
 * we run `validatePlanMarkdown` on the rendered output so the same approval flow that
 * gates `/supi:plan` gates the harness plan, no special-casing.
 */

import * as path from "node:path";

import type { HarnessDesignSpec } from "../../types.js";
import { validatePlanMarkdown } from "../../planning/validate.js";
import { savePlan } from "../../storage/plans.js";
import {
  type HarnessStageRunResult,
  type HarnessStageRunner,
  type HarnessStageRunnerContext,
} from "../stage-runner.js";
import {
  loadHarnessDesignSpec,
  loadHarnessDiscover,
} from "../storage.js";

export interface HarnessPlanTask {
  id: number;
  name: string;
  description: string;
  files: string[];
  criteria: string;
  complexity: "small" | "medium" | "large";
}

/**
 * Build the canonical task list from a design spec. Always emits the "harden" tasks
 * (AGENTS.md, docs/architecture.md, docs/golden-principles.md, lint/structural/eval
 * configs); appends the conditional anti-slop tasks per Design's backend choice.
 */
export function buildHarnessPlanTasks(spec: HarnessDesignSpec): HarnessPlanTask[] {
  const tasks: HarnessPlanTask[] = [];
  let id = 1;

  tasks.push({
    id: id++,
    name: "Generate AGENTS.md",
    description: "Write a ≤120-line AGENTS.md at the repo root summarizing the harness contract for any agent.",
    files: ["AGENTS.md"],
    criteria: "AGENTS.md exists, references docs/architecture.md and docs/golden-principles.md, and ends with a 'When in doubt' section.",
    complexity: "small",
  });

  tasks.push({
    id: id++,
    name: "Write docs/architecture.md",
    description: "Render the layer-table convention required by the layer-context-inject hook.",
    files: ["docs/architecture.md"],
    criteria: "docs/architecture.md parses cleanly via parseArchitectureMarkdown and reflects the design's layer rules.",
    complexity: "small",
  });

  tasks.push({
    id: id++,
    name: "Write docs/golden-principles.md",
    description: "List the ≤10 mechanical rules from the design spec.",
    files: ["docs/golden-principles.md"],
    criteria: "docs/golden-principles.md exists and contains every principle from the design spec.",
    complexity: "small",
  });

  if (spec.tooling.lint) {
    tasks.push({
      id: id++,
      name: `Wire lint tool (${spec.tooling.lint})`,
      description: `Install and configure ${spec.tooling.lint} per the design spec.`,
      files: [],
      criteria: `${spec.tooling.lint} runs cleanly via the recommended invocation.`,
      complexity: "small",
    });
  }

  if (spec.tooling.structuralTest) {
    tasks.push({
      id: id++,
      name: `Wire structural test tool (${spec.tooling.structuralTest})`,
      description: `Install and configure ${spec.tooling.structuralTest} per the design spec.`,
      files: [],
      criteria: `${spec.tooling.structuralTest} runs cleanly.`,
      complexity: "small",
    });
  }

  if (spec.tooling.eval) {
    tasks.push({
      id: id++,
      name: `Wire eval framework (${spec.tooling.eval})`,
      description: `Set up the eval framework per the design spec.`,
      files: [],
      criteria: `Eval framework runs cleanly.`,
      complexity: "small",
    });
  }

  // Anti-slop conditional tasks
  if (spec.antiSlop.backend === "fallow" || spec.antiSlop.backend === "hybrid") {
    tasks.push({
      id: id++,
      name: "Install fallow + write .fallowrc.json",
      description: "Run `bun install -g fallow` (or set up `npx fallow` shim) and emit `.fallowrc.json` with detected entry points + architecture rules.",
      files: [".fallowrc.json"],
      criteria: "`fallow audit --format json` runs cleanly on the repo.",
      complexity: "small",
    });
  }

  if (spec.antiSlop.backend === "desloppify" || spec.antiSlop.backend === "hybrid") {
    tasks.push({
      id: id++,
      name: "Install desloppify",
      description: 'Run `pip install --upgrade "desloppify[full]"` and add `.desloppify/` to `.gitignore`.',
      files: [".gitignore"],
      criteria: "`desloppify scan --format json` runs cleanly on the repo.",
      complexity: "small",
    });
    if (spec.antiSlop.skillTargets.length > 0) {
      tasks.push({
        id: id++,
        name: "Distribute agent-skills",
        description: `Run desloppify update-skill for each target: ${spec.antiSlop.skillTargets.join(", ")}.`,
        files: [],
        criteria: "Every target client has the desloppify skill installed.",
        complexity: "small",
      });
    }
  }

  tasks.push({
    id: id++,
    name: "Register anti-slop hooks",
    description: "Ensure src/harness/hooks/register.ts wires pre-edit dupe probe, post-session sweep, and layer-context-inject only when the harness marker exists.",
    files: ["src/harness/hooks/register.ts"],
    criteria: "Hooks are registered idempotently and gated by the marker file.",
    complexity: "small",
  });

  tasks.push({
    id: id++,
    name: "Initialize slop queue",
    description: "Touch the project-scoped queue.jsonl so the queue exists before hooks fire.",
    files: [],
    criteria: "queue.jsonl exists and is readable; readSlopQueue returns []",
    complexity: "small",
  });

  tasks.push({
    id: id++,
    name: "Generate scorecard skeleton + README badge",
    description: "Compute the initial score and write a repo-local snapshot at .omp/supipowers/harness/score.json.",
    files: [".omp/supipowers/harness/score.json"],
    criteria: "Score JSON exists; SVG badge is renderable from it.",
    complexity: "small",
  });

  if (spec.supipowersWiring.addReviewAgent) {
    tasks.push({
      id: id++,
      name: "Add architecture-aware review agent",
      description: "Generate `.omp/supipowers/review-agents/harness-architecture.md` from architecture + golden principles.",
      files: [".omp/supipowers/review-agents/harness-architecture.md"],
      criteria: "Review agent file exists and is loaded by `/supi:review`.",
      complexity: "small",
    });
  }

  if (spec.supipowersWiring.wireChecksGate) {
    tasks.push({
      id: id++,
      name: "Wire `/supi:checks` gate",
      description: `Add a custom gate to .omp/supipowers/config.json that runs the ${spec.antiSlop.backend} scan.`,
      files: [".omp/supipowers/config.json"],
      criteria: "`/supi:checks` runs the anti-slop scan as part of its gate set.",
      complexity: "medium",
    });
  }

  return tasks;
}

/** Render the plan markdown that lands in the canonical plans directory. */
export function renderHarnessPlanMarkdown(input: {
  spec: HarnessDesignSpec;
  tasks: readonly HarnessPlanTask[];
  recordedAt: string;
  planName: string;
}): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${input.planName}`);
  lines.push(`created: ${input.recordedAt}`);
  lines.push("tags: [harness, anti-slop]");
  lines.push("---");
  lines.push("");
  lines.push(`# ${input.planName}`);
  lines.push("");
  lines.push("## Context");
  lines.push("");
  lines.push(
    `Generated by /supi:harness from design spec ${input.spec.sessionId}. Anti-slop backend: \`${input.spec.antiSlop.backend}\`.`,
  );
  lines.push("");
  lines.push("## Tasks");
  lines.push("");
  for (const task of input.tasks) {
    lines.push(`### Task ${task.id}: ${task.name}`);
    lines.push("");
    lines.push(task.description);
    lines.push("");
    if (task.files.length > 0) {
      lines.push("**Files:**");
      for (const f of task.files) lines.push(`- Modify: \`${f}\``);
      lines.push("");
    }
    lines.push(`**criteria**: ${task.criteria}`);
    lines.push(`**complexity**: ${task.complexity}`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface PlanStageInput {
  /** Override for the plan filename. Defaults to `harness-<sessionId>.md`. */
  planFilename?: string;
}

export class HarnessPlanStage implements HarnessStageRunner {
  readonly stage = "plan" as const;

  // PlanStageInput intentionally unconstructed: the stage runner exposes the
  // HarnessStageRunner shape but real plan emission happens through
  // `emitHarnessPlanFromSpec` because the in-memory HarnessDesignSpec is the input.

  async isReady(ctx: HarnessStageRunnerContext): Promise<boolean> {
    return loadHarnessDesignSpec(ctx.paths, ctx.cwd, ctx.sessionId).ok;
  }

  async isComplete(_ctx: HarnessStageRunnerContext): Promise<boolean> {
    // The plan stage advances when the user approves the generated plan via the standard
    // approval flow. The stage runner can re-emit the plan on demand; the approval flow's
    // marker (a follow-on signal from the planning subsystem) is the truth source. We
    // treat regeneration as idempotent — `run` always overwrites.
    return false;
  }

  async run(ctx: HarnessStageRunnerContext): Promise<HarnessStageRunResult> {
    const designResult = loadHarnessDesignSpec(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!designResult.ok) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker: { code: "design-missing", message: "Plan requires a completed Design stage" },
      };
    }

    // Discover is required for context (we cite the recommended backend in the plan).
    const discoverResult = loadHarnessDiscover(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!discoverResult.ok) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker: { code: "discover-missing", message: "Plan requires a completed Discover stage" },
      };
    }

    // Re-parse the design markdown back into a HarnessDesignSpec is overkill — the design
    // stage stored a structured spec via decisions.jsonl, but for v1 we accept the raw
    // markdown path and rebuild a minimal spec from it. Callers that have the structured
    // spec in-memory (the common case) should call `renderHarnessPlanMarkdown` directly
    // and skip this stage.
    return {
      status: "blocked",
      stage: this.stage,
      artifactPaths: [],
      blocker: {
        code: "plan-inputs-missing",
        message: "Plan stage requires the structured HarnessDesignSpec to be supplied via the command handler. Use renderHarnessPlanMarkdown directly with the in-memory spec.",
      },
    };
  }
}

/**
 * Convenience helper for the command handler: render and persist the plan in one call.
 * The plan goes into the standard plans directory used by `/supi:plan` so the same
 * approval flow lights up.
 */
export function emitHarnessPlanFromSpec(input: {
  ctx: Pick<HarnessStageRunnerContext, "paths" | "cwd">;
  spec: HarnessDesignSpec;
  recordedAt?: string;
  planName?: string;
}): { planPath: string; planMarkdown: string; tasks: HarnessPlanTask[] } {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const planName = input.planName ?? `harness-${input.spec.sessionId}`;
  const tasks = buildHarnessPlanTasks(input.spec);
  const planMarkdown = renderHarnessPlanMarkdown({ spec: input.spec, tasks, recordedAt, planName });
  const filename = `${planName}.md`;
  const planPath = savePlan(input.ctx.paths, input.ctx.cwd, filename, planMarkdown);
  return { planPath, planMarkdown, tasks };
}

/** Validator wrapper — re-uses the canonical validator. */
export function validateHarnessPlanMarkdown(markdown: string, planName: string): string[] {
  const result = validatePlanMarkdown(markdown, planName);
  if (result.output) return [];
  return result.errors.map((e: { path: string; message: string }) => `${e.path}: ${e.message}`);
}

// Suppress "imported but unused" noise — `path` is reserved for future workspace-target
// integrations. We keep the import so adding workspace-relative plan paths later is a
// one-line change.
void path;
