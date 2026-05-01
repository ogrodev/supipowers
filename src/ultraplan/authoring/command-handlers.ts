/**
 * Slash-command handlers for the multi-stage authoring pipeline.
 *
 * Each exported `handle*` function corresponds to a `/supi:ultraplan <subcommand>`. They wire
 * the picker, TUI input, and pipeline driver so the command file (`src/commands/ultraplan.ts`)
 * stays focused on routing.
 *
 * These handlers are deliberately UI-light: they call `ctx.ui.input` and `ctx.ui.select` for
 * the user gate moments specified in the plan; everything else is delegated to
 * `runPipelineUntilGate` and the per-stage runners.
 */

import * as fs from "node:fs";

import type { Platform } from "../../platform/types.js";
import { notifyError, notifyInfo, notifyWarning } from "../../notifications/renderer.js";
import { loadModelConfig } from "../../config/model-config.js";
import {
  getUltraplanAuthoringDir,
  getUltraplanSessionDir,
} from "../project-paths.js";
import {
  ULTRAPLAN_AUTHORED_JSON_FILENAME,
} from "../project-paths.js";
import { loadUltraPlanIndex, saveUltraPlanManifest } from "../storage.js";
import {
  listInFlightAuthoringSessions,
  runPipelineUntilGate,
  runStage,
  type PipelineGateMode,
} from "./pipeline.js";
import type {
  UltraPlanAuthoringStage,
  UltraPlanManifest,
} from "../../types.js";
import path from "node:path";

const ULTRAPLAN_ID_PREFIX = "up-";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newAuthoringSessionId(now: () => Date = () => new Date()): string {
  // Mirrors the existing convention in authoring-wizard.ts: `up-<ms>-<rand>`.
  const ms = now().getTime();
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `${ULTRAPLAN_ID_PREFIX}${ms.toString(36)}-${rand}`;
}

function projectName(cwd: string): string {
  return path.basename(path.resolve(cwd));
}

function makeBootstrapManifest(sessionId: string, projName: string): UltraPlanManifest {
  const nowIso = new Date().toISOString();
  return {
    sessionId,
    projectName: projName,
    title: "(authoring)",
    authored: { json: ULTRAPLAN_AUTHORED_JSON_FILENAME, markdown: undefined as never },
    state: "ready",
    cursor: null,
    lastCompleted: null,
    progress: { total: 0, terminal: 0, blocked: 0 },
    stacks: [],
    blocker: null,
    reviews: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function isInFlightStage(stage: UltraPlanAuthoringStage): boolean {
  return stage !== "approve";
}

function readSessionsFromIndex(platform: Platform, cwd: string): string[] {
  const index = loadUltraPlanIndex(platform.paths, cwd);
  if (!index.ok) return [];
  return index.value.sessions.map((s) => s.sessionId);
}

function isSessionPromoted(platform: Platform, cwd: string, sessionId: string): boolean {
  // A promoted session has its canonical authored.json in the session dir.
  const dir = getUltraplanSessionDir(platform.paths, cwd, sessionId);
  return fs.existsSync(path.join(dir, ULTRAPLAN_AUTHORED_JSON_FILENAME));
}

// ---------------------------------------------------------------------------
// Bare-entry handler
// ---------------------------------------------------------------------------

export interface BareEntryInput {
  platform: Platform;
  ctx: any;
}

/**
 * Bare `/supi:ultraplan` invocation: detect in-flight authoring sessions, offer Resume /
 * Start fresh / Cancel, then drive the pipeline.
 */
export async function handleBareEntry(input: BareEntryInput): Promise<void> {
  const { platform, ctx } = input;
  if (!ctx.hasUI) {
    notifyWarning(ctx, "UltraPlan authoring requires interactive mode");
    return;
  }

  const allSessionIds = readSessionsFromIndex(platform, ctx.cwd);
  const inFlight = listInFlightAuthoringSessions(platform.paths, ctx.cwd, allSessionIds)
    .filter((s) => isInFlightStage(s.stage) && !isSessionPromoted(platform, ctx.cwd, s.sessionId));

  // Step 1: in-flight picker.
  let resumeSessionId: string | null = null;
  if (inFlight.length > 0) {
    const options = [
      ...inFlight.map((s) => ({
        label: `Resume ${s.sessionId} (stage: ${s.stage}, status: ${s.status})`,
        value: `resume:${s.sessionId}`,
      })),
      { label: "Start fresh", value: "fresh" },
      { label: "Cancel", value: "cancel" },
    ];
    const choice = await ctx.ui.select("In-flight UltraPlan authoring sessions", options);
    if (!choice || choice === "cancel") return;
    if (choice.startsWith("resume:")) resumeSessionId = choice.slice("resume:".length);
  }

  if (resumeSessionId) {
    await driveAuthoringPipeline({
      platform,
      ctx,
      sessionId: resumeSessionId,
      seedPrompt: "",
      gates: "default",
    });
    return;
  }

  // Step 2: capture seed prompt via TUI input.
  const seed = await ctx.ui.input("What do you want to ship next?", {
    multiline: true,
    helpText: "Describe the work; press Enter to submit, Esc to cancel.",
  });
  if (!seed || seed.trim().length === 0) return;

  const sessionId = newAuthoringSessionId();
  // Bootstrap manifest so the authoring storage helpers have a host artifact.
  const manifestSave = saveUltraPlanManifest(
    platform.paths,
    ctx.cwd,
    sessionId,
    makeBootstrapManifest(sessionId, projectName(ctx.cwd)),
  );
  if (!manifestSave.ok) {
    notifyError(ctx, "Failed to create authoring session", manifestSave.error.message);
    return;
  }

  await driveAuthoringPipeline({ platform, ctx, sessionId, seedPrompt: seed, gates: "default" });
}

// ---------------------------------------------------------------------------
// Pipeline driver wrapper (UI-aware loop)
// ---------------------------------------------------------------------------

interface DriveInput {
  platform: Platform;
  ctx: any;
  sessionId: string;
  seedPrompt: string;
  gates: PipelineGateMode;
  iteration?: number;
}

/**
 * Run the pipeline driver in a loop until the session is approved, blocked, or the user
 * cancels. Between gates, presents a `ctx.ui.confirm` to advance.
 */
export async function driveAuthoringPipeline(input: DriveInput): Promise<void> {
  const modelConfig = loadModelConfig(input.platform.paths, input.ctx.cwd);
  let attempts = 0;
  while (attempts < 8) {
    attempts += 1;
    const outcome = await runPipelineUntilGate({
      platform: input.platform,
      paths: input.platform.paths,
      cwd: input.ctx.cwd,
      sessionId: input.sessionId,
      modelConfig,
      seedPrompt: input.seedPrompt,
      gates: input.gates,
      iteration: input.iteration ?? 1,
    });

    if (outcome.status === "completed" || outcome.status === "skipped") {
      if (outcome.promoted) {
        notifyInfo(input.ctx, "UltraPlan approved", `Session ${input.sessionId} is ready to run.`);
      } else {
        notifyInfo(input.ctx, "UltraPlan stage completed", `Stage ${outcome.stage} done.`);
      }
      return;
    }

    if (outcome.status === "failed" || outcome.status === "blocked") {
      notifyError(input.ctx, `UltraPlan ${outcome.status} at ${outcome.stage}`, outcome.message ?? "");
      return;
    }

    if (outcome.status === "awaiting-user") {
      const advance = await input.ctx.ui.confirm
        ? await input.ctx.ui.confirm(
            `UltraPlan: ${outcome.stage} ready`,
            `The ${outcome.stage} stage finished. Continue to the next stage?`,
          )
        : true;
      if (!advance) {
        notifyInfo(input.ctx, "UltraPlan paused", `Resume with /supi:ultraplan resume ${input.sessionId}`);
        return;
      }
      continue;
    }
  }
  notifyWarning(input.ctx, "UltraPlan: too many gates", "Driver loop hit its safety cap; resume to continue.");
}

// ---------------------------------------------------------------------------
// Per-stage subcommand handlers
// ---------------------------------------------------------------------------

export async function handleStageSubcommand(
  stage: UltraPlanAuthoringStage,
  platform: Platform,
  ctx: any,
  args: string,
): Promise<void> {
  if (!ctx.hasUI) {
    notifyWarning(ctx, "UltraPlan authoring requires interactive mode");
    return;
  }

  const sessionId = args.trim() || (await pickInFlightSession(platform, ctx));
  if (!sessionId) return;

  const seedPrompt = stage === "intake"
    ? (await ctx.ui.input("What do you want to ship next?", { multiline: true })) ?? ""
    : "";

  const modelConfig = loadModelConfig(platform.paths, ctx.cwd);
  const result = await runStage(stage, {
    platform,
    paths: platform.paths,
    cwd: ctx.cwd,
    sessionId,
    modelConfig,
    seedPrompt,
  });

  if (result.status === "completed" || result.status === "skipped") {
    notifyInfo(ctx, `UltraPlan ${stage} done`, result.details ? JSON.stringify(result.details) : "");
    return;
  }
  if (result.status === "awaiting-user") {
    notifyInfo(ctx, `UltraPlan ${stage} awaiting user`, "Continue with the next stage when ready.");
    return;
  }
  notifyError(ctx, `UltraPlan ${stage} ${result.status}`, result.error ?? result.blocker?.message ?? "");
}

async function pickInFlightSession(platform: Platform, ctx: any): Promise<string | null> {
  const allSessionIds = readSessionsFromIndex(platform, ctx.cwd);
  const inFlight = listInFlightAuthoringSessions(platform.paths, ctx.cwd, allSessionIds)
    .filter((s) => !isSessionPromoted(platform, ctx.cwd, s.sessionId));
  if (inFlight.length === 0) {
    notifyWarning(ctx, "No in-flight authoring sessions", "Start one with /supi:ultraplan");
    return null;
  }
  if (inFlight.length === 1) return inFlight[0]!.sessionId;
  const choice = await ctx.ui.select(
    "Pick an in-flight session",
    inFlight.map((s) => ({ label: `${s.sessionId} (${s.stage})`, value: s.sessionId })),
  );
  return typeof choice === "string" ? choice : null;
}

// ---------------------------------------------------------------------------
// Resume + plan + quick handlers
// ---------------------------------------------------------------------------

export async function handleResume(platform: Platform, ctx: any, args: string): Promise<void> {
  const arg = args.trim();
  if (arg.length > 0) {
    const dir = getUltraplanAuthoringDir(platform.paths, ctx.cwd, arg);
    if (!fs.existsSync(dir)) {
      notifyError(ctx, "No authoring session", `No authoring directory found for ${arg}`);
      return;
    }
    await driveAuthoringPipeline({ platform, ctx, sessionId: arg, seedPrompt: "", gates: "default" });
    return;
  }
  // No id arg: pick from in-flight list.
  const sessionId = await pickInFlightSession(platform, ctx);
  if (!sessionId) return;
  await driveAuthoringPipeline({ platform, ctx, sessionId, seedPrompt: "", gates: "default" });
}

export async function handlePlan(platform: Platform, ctx: any, args: string): Promise<void> {
  if (!ctx.hasUI) {
    notifyWarning(ctx, "UltraPlan authoring requires interactive mode");
    return;
  }
  const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
  let gates: PipelineGateMode = "default";
  const positional: string[] = [];
  for (const tok of tokens) {
    if (tok === "--auto") gates = "auto";
    else if (tok === "--manual") gates = "manual";
    else positional.push(tok);
  }
  let seed = positional.join(" ").trim();
  if (seed.length === 0) {
    seed = (await ctx.ui.input("What do you want to ship next?", { multiline: true })) ?? "";
  }
  if (seed.length === 0) return;

  const sessionId = newAuthoringSessionId();
  const manifestSave = saveUltraPlanManifest(
    platform.paths,
    ctx.cwd,
    sessionId,
    makeBootstrapManifest(sessionId, projectName(ctx.cwd)),
  );
  if (!manifestSave.ok) {
    notifyError(ctx, "Failed to create authoring session", manifestSave.error.message);
    return;
  }
  await driveAuthoringPipeline({ platform, ctx, sessionId, seedPrompt: seed, gates });
}
