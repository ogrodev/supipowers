/**
 * DESIGN stage runner.
 *
 * Reads the discover + research artifacts and produces `<session>/design-spec.md` plus
 * `<session>/decisions.jsonl`. The interactive Q&A flow lives in the command handler
 * (it owns `planning_ask`); the stage runner builds the spec deterministically from a
 * `HarnessDesignSpec` object the handler hands in.
 *
 * Why split this way? Mirrors `src/planning/approval-flow.ts`: stage runners are pure
 * functions of the inputs on disk, while the interactive UI sits in the command layer.
 * That makes the stage runner trivially testable.
 */

import {
  type HarnessStageRunResult,
  type HarnessStageRunner,
  type HarnessStageRunnerContext,
  nowIso,
} from "../stage-runner.js";
import {
  appendHarnessDecision,
  loadHarnessDiscover,
  loadHarnessDesignSpec,
  saveHarnessDesignSpec,
  saveHarnessDesignSpecJson,
} from "../storage.js";
import type {
  HarnessCiConfig,
  HarnessDesignSpec,
  HarnessDiscoverArtifact,
  HarnessQualityGate,
} from "../../types.js";
import { DEFAULT_HARNESS_HOOK_CONFIG } from "../hooks/register.js";

function mdCell(value: string | null): string {
  return (value ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function packageCommand(discover: HarnessDiscoverArtifact, script: string): string {
  if (discover.packageManagers.includes("bun")) return `bun run ${script}`;
  if (discover.packageManagers.includes("pnpm")) return `pnpm ${script}`;
  if (discover.packageManagers.includes("yarn")) return `yarn ${script}`;
  return `npm run ${script}`;
}

export function defaultCiConfigFromDiscover(discover: HarnessDiscoverArtifact): HarnessCiConfig {
  const manager = discover.packageManagers[0];
  const localCommand = manager === "pnpm"
    ? "pnpm harness:quality"
    : manager === "yarn"
      ? "yarn harness:quality"
      : manager === "npm"
        ? "npm run harness:quality"
        : "bun run harness:quality";
  return {
    provider: "github-actions",
    trigger: { mode: "branches", branches: ["dev", "main"] },
    localCommand,
    workflowPath: ".github/workflows/harness-quality.yml",
    prComment: { enabled: true, mode: "every-push" },
  };
}


export function defaultValidationGatesFromDiscover(discover: HarnessDiscoverArtifact): HarnessQualityGate[] {
  const gates: HarnessQualityGate[] = [];
  const lintTool = discover.lintTools[0];
  if (lintTool) {
    gates.push({
      name: "lint",
      invariant: "Source code should satisfy the repository's configured mechanical style and static lint rules before review.",
      command: packageCommand(discover, "lint"),
      proves: `${lintTool} accepts the files covered by the configured lint target.`,
      doesNotProve: "Runtime behavior, type soundness, accessibility, and architecture boundaries are outside this proof.",
      runsAt: "local command and CI when wired",
      blocksOn: "non-zero exit code from the configured lint command",
      artifact: "terminal output or CI log",
      failSafe: "If no lint script exists, the design must either add one or remove this gate explicitly.",
    });
  }

  if (discover.languages.some((lang) => lang === "typescript" || lang === "tsx" || lang === "javascript")) {
    gates.push({
      name: "typecheck",
      invariant: "Compile-time contracts must stay coherent before generated harness artifacts claim the repo is safe to edit.",
      command: packageCommand(discover, "typecheck"),
      proves: "The configured type checker accepts the current source and declaration graph.",
      doesNotProve: "Runtime data shapes, third-party responses, and user workflows are not executed.",
      runsAt: "local command and CI when wired",
      blocksOn: "non-zero exit code from the typecheck command",
      artifact: "terminal output or CI log",
      failSafe: "If the command is unavailable, the gate fails until the design names the repository's actual type proof.",
    });
  }

  const testTool = discover.testTools[0];
  if (testTool) {
    gates.push({
      name: "test",
      invariant: "Implemented behavior should keep the repository's focused unit and integration checks passing.",
      command: packageCommand(discover, "test"),
      proves: `${testTool} passes for the tests selected by the repository's test script.`,
      doesNotProve: "Untested workflows, production integrations, and visual/accessibility regressions remain possible.",
      runsAt: "local command and CI when wired",
      blocksOn: "non-zero exit code from the test command",
      artifact: "terminal output or CI log",
      failSafe: "If deterministic test dependencies are missing, add fixtures or documented test-safe fallbacks before accepting the gate.",
    });
  }

  gates.push({
    name: "anti-slop-scan",
    invariant: "New harness work must not introduce unresolved duplicate, dead-code, or architecture-drift findings without queue visibility.",
    command: null,
    proves: `${discover.recommendedBackend} scan results were merged into the harness slop queue and scorecard.`,
    doesNotProve: "Semantic correctness, product behavior, and findings hidden from the selected backend are outside this proof.",
    runsAt: "/supi:harness validate and optional /supi:checks wiring",
    blocksOn: "adapter error, strict score floor failure, or release-blocking score-floor policy when enabled",
    artifact: "validate-report.json, queue.jsonl, score.json",
    failSafe: "Missing optional external backends soft-fail with a warning; configured adapter errors block validation.",
  });

  return gates;
}

/**
 * Render a HarnessDesignSpec into the markdown that lands at `<session>/design-spec.md`.
 * Pure function for testability.
 */
export function renderDesignSpec(spec: HarnessDesignSpec): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`sessionId: ${spec.sessionId}`);
  lines.push(`recordedAt: ${spec.recordedAt}`);
  lines.push(`backend: ${spec.antiSlop.backend}`);
  lines.push("---");
  lines.push("");
  lines.push("# Harness Design Spec");
  lines.push("");
  lines.push("## 1. Layered architecture");
  lines.push("");
  if (spec.layerRules.length === 0) {
    lines.push("_No layered rules — single-bucket repo._");
  } else {
    lines.push("| Layer | Files | Allowed | Forbidden | Notes |");
    lines.push("|---|---|---|---|---|");
    for (const rule of spec.layerRules) {
      const allowed = rule.allowedImports.length > 0 ? rule.allowedImports.join(", ") : "—";
      const forbidden = rule.forbiddenImports.length > 0 ? rule.forbiddenImports.join(", ") : "—";
      const notes = rule.description ?? "—";
      const files = rule.globs.map((g) => `\`${g}\``).join(", ");
      lines.push(`| ${rule.layer} | ${files} | ${allowed} | ${forbidden} | ${notes} |`);
    }
  }
  lines.push("");
  lines.push("## 2. Taste invariants");
  lines.push("");
  for (const inv of spec.tasteInvariants) lines.push(`- ${inv}`);
  if (spec.tasteInvariants.length === 0) lines.push("_None recorded._");
  lines.push("");
  lines.push("## 3. Tooling choices");
  lines.push("");
  lines.push(`- Lint: ${spec.tooling.lint ?? "(none)"}`);
  lines.push(`- Structural test: ${spec.tooling.structuralTest ?? "(none)"}`);
  lines.push(`- Eval framework: ${spec.tooling.eval ?? "(none)"}`);
  lines.push("");
  lines.push("## 4. Golden principles");
  lines.push("");
  for (let i = 0; i < spec.goldenPrinciples.length; i += 1) {
    lines.push(`${i + 1}. ${spec.goldenPrinciples[i]}`);
  }
  if (spec.goldenPrinciples.length === 0) lines.push("_None recorded._");
  lines.push("");
  lines.push("## 5. Documentation tree");
  lines.push("");
  for (const doc of spec.docsTree) lines.push(`- \`${doc}\``);
  if (spec.docsTree.length === 0) lines.push("_None recorded._");
  lines.push("");
  lines.push("## 6. Validation gates");
  lines.push("");
  if (spec.validationGates.length === 0) {
    lines.push("_None recorded._");
  } else {
    lines.push("| Gate | Invariant | Command | Proves | Does not prove | Runs at | Blocks on | Artifact | Fail-safe |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const gate of spec.validationGates) {
      lines.push(
        `| ${mdCell(gate.name)} | ${mdCell(gate.invariant)} | ${mdCell(gate.command)} | ${mdCell(gate.proves)} | ${mdCell(gate.doesNotProve)} | ${mdCell(gate.runsAt)} | ${mdCell(gate.blocksOn)} | ${mdCell(gate.artifact)} | ${mdCell(gate.failSafe)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## 7. CI and local quality command");
  lines.push("");
  lines.push(`- Provider: ${spec.ci.provider}`);
  lines.push(`- PR trigger: ${
    spec.ci.trigger.mode === "all-prs" ? "all PRs" : `PRs targeting ${spec.ci.trigger.branches.join(", ")}`
  }`);
  lines.push(`- Local command: \`${spec.ci.localCommand}\``);
  lines.push(`- Workflow path: \`${spec.ci.workflowPath}\``);
  lines.push("");
  lines.push("## 8. Supipowers wiring");
  lines.push("");
  lines.push(`- Add review agent (\`harness-architecture\`): ${spec.supipowersWiring.addReviewAgent ? "yes" : "no"}`);
  lines.push(`- Wire into \`/supi:checks\` as a gate: ${spec.supipowersWiring.wireChecksGate ? "yes" : "no"}`);
  lines.push("");
  lines.push("## 9. Anti-slop guardrails");
  lines.push("");
  lines.push(`- Backend: \`${spec.antiSlop.backend}\``);
  lines.push(`- Pre-edit dupe probe: ${spec.antiSlop.hooks.pre_edit_dupe_probe.enabled ? "enabled" : "disabled"}`);
  lines.push(`- Post-session sweep: ${spec.antiSlop.hooks.post_session_sweep.enabled ? "enabled" : "disabled"}`);
  lines.push(`- Layer-context inject: ${spec.antiSlop.hooks.layer_context_inject.enabled ? "enabled" : "disabled"}`);
  lines.push(
    `- Score floor: strict ≥${spec.antiSlop.hooks.score_floor.strict}, lenient ≥${spec.antiSlop.hooks.score_floor.lenient} (release-blocking: ${
      spec.antiSlop.hooks.score_floor.release_blocking ? "yes" : "no"
    })`,
  );
  lines.push(`- Agent-skill distribution targets: ${spec.antiSlop.skillTargets.length > 0 ? spec.antiSlop.skillTargets.join(", ") : "(none)"}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Schema-level validator for a design spec. Returns error messages (empty when valid).
 * The plan calls for a "spec-reviewer sub-agent" — that's a separate downstream step;
 * this validator catches mechanical issues (missing sections, malformed scores) early.
 */
export function validateDesignSpec(spec: HarnessDesignSpec): string[] {
  const errors: string[] = [];
  const validBackends = new Set(["fallow", "desloppify", "supi-native", "hybrid"]);
  if (!validBackends.has(spec.antiSlop.backend)) {
    errors.push(`anti-slop backend must be one of fallow|desloppify|supi-native|hybrid (got "${spec.antiSlop.backend}")`);
  }
  if (spec.antiSlop.hooks.score_floor.strict < 0 || spec.antiSlop.hooks.score_floor.strict > 100) {
    errors.push("score_floor.strict must be in 0..100");
  }
  if (spec.antiSlop.hooks.score_floor.lenient < 0 || spec.antiSlop.hooks.score_floor.lenient > 100) {
    errors.push("score_floor.lenient must be in 0..100");
  }
  if (spec.antiSlop.hooks.pre_edit_dupe_probe.threshold < 0 || spec.antiSlop.hooks.pre_edit_dupe_probe.threshold > 1) {
    errors.push("pre_edit_dupe_probe.threshold must be in 0..1");
  }
  if (spec.antiSlop.hooks.layer_context_inject.addendum_max_chars < 0) {
    errors.push("layer_context_inject.addendum_max_chars must be ≥0");
  }
  for (const [index, gate] of spec.validationGates.entries()) {
    const prefix = `validationGates[${index}]`;
    for (const field of ["name", "invariant", "proves", "doesNotProve", "runsAt", "blocksOn", "artifact", "failSafe"] as const) {
      if (!hasText(gate[field])) errors.push(`${prefix}.${field} must be non-empty`);
    }
    if (gate.command !== null && !hasText(gate.command)) {
      errors.push(`${prefix}.command must be non-empty or null`);
    }
  }
  if (spec.ci.provider !== "github-actions") {
    errors.push("ci.provider must be github-actions");
  }
  if (!hasText(spec.ci.localCommand)) {
    errors.push("ci.localCommand must be non-empty");
  }
  if (!hasText(spec.ci.workflowPath)) {
    errors.push("ci.workflowPath must be non-empty");
  }
  if (spec.ci.trigger.mode === "branches" && spec.ci.trigger.branches.filter((b) => b.trim().length > 0).length === 0) {
    errors.push("ci.trigger.branches must contain at least one branch when mode is branches");
  }
  return errors;
}

/**
 * Build a sensible default `HarnessDesignSpec` from a Discover artifact. Used by the
 * per-stage `/supi:harness design` subcommand when the user has not already authored a
 * structured spec; lets the pipeline run end-to-end without an interactive Q&A.
 *
 * The spec is intentionally conservative — it picks the first discovered tool per
 * category, leaves layer rules / golden principles empty, and inherits the discover
 * artifact's recommended anti-slop backend.
 */
export function defaultDesignSpecFromDiscover(
  discover: HarnessDiscoverArtifact,
  sessionId: string,
  recordedAt: string,
): HarnessDesignSpec {
  const lint = discover.lintTools[0] ?? null;
  const structuralTest = discover.testTools[0] ?? null;
  return {
    sessionId,
    recordedAt,
    layerRules: [],
    tasteInvariants: [],
    tooling: {
      lint,
      structuralTest,
      eval: null,
    },
    goldenPrinciples: [],
    docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
    validationGates: defaultValidationGatesFromDiscover(discover),
    ci: defaultCiConfigFromDiscover(discover),
    supipowersWiring: { addReviewAgent: true, wireChecksGate: false },
    antiSlop: {
      backend: discover.recommendedBackend,
      hooks: DEFAULT_HARNESS_HOOK_CONFIG,
      skillTargets: [],
    },
  };
}

export interface DesignStageInput {
  /** Pre-built spec, typically composed by the command handler from interactive Q&A. */
  spec: HarnessDesignSpec;
}

export class HarnessDesignStage implements HarnessStageRunner {
  readonly stage = "design" as const;

  constructor(private readonly input: DesignStageInput) {}

  async isReady(ctx: HarnessStageRunnerContext): Promise<boolean> {
    return loadHarnessDiscover(ctx.paths, ctx.cwd, ctx.sessionId).ok;
  }

  async isComplete(ctx: HarnessStageRunnerContext): Promise<boolean> {
    return loadHarnessDesignSpec(ctx.paths, ctx.cwd, ctx.sessionId).ok;
  }

  async run(ctx: HarnessStageRunnerContext): Promise<HarnessStageRunResult> {
    const errors = validateDesignSpec(this.input.spec);
    if (errors.length > 0) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker: {
          code: "design-spec-invalid",
          message: `design spec validation failed: ${errors.join("; ")}`,
        },
      };
    }

    const recordedAt = nowIso(ctx);
    const specWithTimestamp: HarnessDesignSpec = { ...this.input.spec, recordedAt };
    const markdown = renderDesignSpec(specWithTimestamp);
    const persisted = saveHarnessDesignSpec(ctx.paths, ctx.cwd, ctx.sessionId, markdown);
    if (!persisted.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `failed to persist design spec: ${persisted.error.message}`,
      };
    }
    const persistedJson = saveHarnessDesignSpecJson(
      ctx.paths,
      ctx.cwd,
      ctx.sessionId,
      specWithTimestamp,
    );
    if (!persistedJson.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [persisted.value],
        error: `failed to persist design spec JSON: ${persistedJson.error.message}`,
      };
    }
    appendHarnessDecision(ctx.paths, ctx.cwd, ctx.sessionId, {
      recordedAt,
      area: "design-spec-saved",
      question: "design spec persisted",
      decision: persisted.value,
    });
    return {
      status: "awaiting-user",
      stage: this.stage,
      artifactPaths: ["design-spec.md", "design-spec.json"],
      details: {
        backend: specWithTimestamp.antiSlop.backend,
        layerCount: specWithTimestamp.layerRules.length,
      },
    };
  }
}
