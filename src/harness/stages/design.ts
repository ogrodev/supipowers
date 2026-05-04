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
} from "../storage.js";
import type { HarnessDesignSpec } from "../../types.js";

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
  for (const gate of spec.validationGates) lines.push(`- ${gate}`);
  if (spec.validationGates.length === 0) lines.push("_None recorded._");
  lines.push("");
  lines.push("## 7. Supipowers wiring");
  lines.push("");
  lines.push(`- Add review agent (\`harness-architecture\`): ${spec.supipowersWiring.addReviewAgent ? "yes" : "no"}`);
  lines.push(`- Wire into \`/supi:checks\` as a gate: ${spec.supipowersWiring.wireChecksGate ? "yes" : "no"}`);
  lines.push("");
  lines.push("## 8. Anti-slop guardrails");
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
  return errors;
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
    appendHarnessDecision(ctx.paths, ctx.cwd, ctx.sessionId, {
      recordedAt,
      area: "design-spec-saved",
      question: "design spec persisted",
      decision: persisted.value,
    });
    return {
      status: "awaiting-user",
      stage: this.stage,
      artifactPaths: ["design-spec.md"],
      details: {
        backend: specWithTimestamp.antiSlop.backend,
        layerCount: specWithTimestamp.layerRules.length,
      },
    };
  }
}
