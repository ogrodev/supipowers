import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { stopExecution } from "../execution/workflow-executor";
import { writePlanArtifact } from "../storage/artifacts";
import { appendWorkflowEvent } from "../storage/events-log";
import type { WorkflowState } from "../types";
import { getRuntime, persistAndRender } from "./shared";

export const REWIND_PHASES = ["idle", "brainstorming", "planning", "plan_ready"] as const;
export type RewindPhase = typeof REWIND_PHASES[number];

interface RewindOption {
  phase: RewindPhase;
  label: string;
  details: string;
}

const REWIND_OPTIONS: RewindOption[] = [
  {
    phase: "idle",
    label: "Full reset (keep objective)",
    details: "Clears checkpoints and plan path",
  },
  {
    phase: "brainstorming",
    label: "Back to brainstorming",
    details: "Redo discovery/decision process",
  },
  {
    phase: "planning",
    label: "Back to planning",
    details: "Discard current plan artifact and regenerate",
  },
  {
    phase: "plan_ready",
    label: "Jump to plan_ready",
    details: "Prepare an executable plan and stop before running",
  },
];

export interface ParsedRewindArgs {
  to?: string;
  yes: boolean;
}

export interface RewoundStateResult {
  state: WorkflowState;
  generatedPlanPath?: string;
}

export function parseRewindArgs(args: string): ParsedRewindArgs {
  const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
  let to: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--to") {
      to = tokens[i + 1];
      i += 1;
      continue;
    }

    if (token.startsWith("--to=")) {
      to = token.slice(5);
      continue;
    }

    if (!token.startsWith("--") && !to) {
      to = token;
    }
  }

  return {
    to,
    yes: tokens.includes("--yes"),
  };
}

export function isRewindPhase(value: string | undefined): value is RewindPhase {
  if (!value) return false;
  return (REWIND_PHASES as readonly string[]).includes(value);
}

function formatOption(option: RewindOption): string {
  return `${option.phase} — ${option.label} (${option.details})`;
}

function parseSelectedPhase(selection: string): RewindPhase | undefined {
  const phase = selection.split(" — ")[0]?.trim();
  return isRewindPhase(phase) ? phase : undefined;
}

function nextActionForPhase(phase: RewindPhase): string {
  switch (phase) {
    case "idle":
      return "Run /sp-start to initialize a workflow";
    case "brainstorming":
      return "Refine requirements and run /sp-start to auto-plan when ready";
    case "planning":
      return "Regenerate plan artifact by running /sp-start or /sp-execute";
    case "plan_ready":
      return "Run /sp-execute to execute the prepared plan";
    default:
      return "Run /sp-status";
  }
}

export function buildRewoundState(cwd: string, state: WorkflowState, to: RewindPhase): RewoundStateResult {
  if (to === "idle") {
    return {
      state: {
        ...state,
        phase: "idle",
        blocker: undefined,
        nextAction: nextActionForPhase("idle"),
        planArtifactPath: undefined,
        checkpoints: {
          hasDesignApproval: false,
          hasPlanArtifact: false,
          hasReviewPass: false,
        },
        updatedAt: Date.now(),
      },
    };
  }

  if (to === "brainstorming") {
    return {
      state: {
        ...state,
        phase: "brainstorming",
        blocker: undefined,
        nextAction: nextActionForPhase("brainstorming"),
        planArtifactPath: undefined,
        checkpoints: {
          hasDesignApproval: false,
          hasPlanArtifact: false,
          hasReviewPass: false,
        },
        updatedAt: Date.now(),
      },
    };
  }

  if (to === "planning") {
    return {
      state: {
        ...state,
        phase: "planning",
        blocker: undefined,
        nextAction: nextActionForPhase("planning"),
        planArtifactPath: undefined,
        checkpoints: {
          hasDesignApproval: true,
          hasPlanArtifact: false,
          hasReviewPass: false,
        },
        updatedAt: Date.now(),
      },
    };
  }

  const existingPlanPath = state.planArtifactPath && existsSync(state.planArtifactPath)
    ? state.planArtifactPath
    : undefined;

  const planPath = existingPlanPath ?? writePlanArtifact(cwd, state.objective ?? "");

  return {
    generatedPlanPath: existingPlanPath ? undefined : planPath,
    state: {
      ...state,
      phase: "plan_ready",
      blocker: undefined,
      nextAction: nextActionForPhase("plan_ready"),
      planArtifactPath: planPath,
      checkpoints: {
        hasDesignApproval: true,
        hasPlanArtifact: true,
        hasReviewPass: false,
      },
      updatedAt: Date.now(),
    },
  };
}

function rewindUsage(): string {
  return `Usage: /sp-rewind [phase] [--to <phase>] [--yes]\nAvailable phases: ${REWIND_PHASES.join(", ")}`;
}

export function registerSpRewindCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-rewind", {
    description: "Rewind workflow to a previous phase using interactive selection",
    async handler(args, ctx) {
      const { config, state } = getRuntime(ctx);
      const parsed = parseRewindArgs(args);
      let target = parsed.to;

      if (!target && ctx.hasUI) {
        const selected = await ctx.ui.select(
          "Rewind Supipowers workflow",
          REWIND_OPTIONS.map(formatOption),
        );

        if (!selected) {
          ctx.ui.notify("Rewind cancelled.", "info");
          return;
        }

        target = parseSelectedPhase(selected);
      }

      if (!isRewindPhase(target)) {
        persistAndRender(ctx, config, state, `Invalid rewind phase. ${rewindUsage()}`, "warning");
        return;
      }

      if (target === state.phase) {
        persistAndRender(ctx, config, state, `Workflow is already in '${target}'.`, "info");
        return;
      }

      if (!parsed.yes && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Rewind Supipowers workflow",
          `Rewind from '${state.phase}' to '${target}'?\nThis can discard current progress/checkpoints.`,
        );

        if (!ok) {
          ctx.ui.notify("Rewind cancelled.", "info");
          return;
        }
      }

      let stopRunId: string | undefined;
      if (state.phase === "executing") {
        const stop = stopExecution(ctx.cwd);
        if (stop.stopped) {
          stopRunId = stop.runId;
        }
      }

      const rewound = buildRewoundState(ctx.cwd, state, target);

      appendWorkflowEvent(ctx.cwd, {
        ts: Date.now(),
        type: "workflow_rewound",
        phase: rewound.state.phase,
        meta: {
          from: state.phase,
          to: rewound.state.phase,
          stoppedRunId: stopRunId,
          generatedPlanPath: rewound.generatedPlanPath,
        },
      });

      const details = [
        `Workflow rewound to '${rewound.state.phase}'.`,
        rewound.generatedPlanPath ? `Plan regenerated at ${rewound.generatedPlanPath}.` : undefined,
        stopRunId ? `Stopped active run ${stopRunId}.` : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join(" ");

      persistAndRender(ctx, config, rewound.state, details, "info");
    },
  });
}
