/**
 * `/supi:harness` command dispatcher.
 *
 * Sub-commands:
 *  - bare entry (no args)        — detect installation; prompt harden/rebuild/cancel.
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
 *
 * The dispatcher is intentionally thin — heavy lifting is in `pipeline.ts`, the stage
 * runners, and `gc/runner.ts`. The command file routes args to the right entry point and
 * surfaces UI-level errors via `notifyError`/`notifyInfo`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Platform, PlatformPaths } from "../platform/types.js";
import { notifyError, notifyInfo } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { loadModelConfig } from "../config/model-config.js";
import { getProjectStatePath } from "../workspace/state-paths.js";
import { loadMarker, describeMarker } from "./bare-entry.js";
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
  readSlopQueue,
  saveHarnessSession,
} from "./storage.js";
import { computeScore } from "./anti_slop/score.js";
import {
  type BuildRunnerInput,
  type PipelineRunOutcome,
  runHarnessPipelineUntilGate,
} from "./pipeline.js";
import { defaultDesignSpecFromDiscover } from "./stages/design.js";
import { newHarnessSessionId } from "./stage-runner.js";
import { buildBackendAdapter } from "./anti_slop/backend-factory.js";
import { DEFAULT_HARNESS_CONFIG } from "./hooks/register.js";
import type { HarnessSession, HarnessStage } from "../types.js";

modelRegistry.register({
  id: "harness",
  category: "command",
  label: "Harness",
  harnessRoleHint: "plan",
});

export interface HarnessCommandContext {
  cwd: string;
  hasUI?: boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select?: (title: string, options: unknown[]) => Promise<string | null>;
    input?: (label: string) => Promise<string | null>;
  };
}

const SUBCOMMANDS = new Set([
  "discover",
  "research",
  "design",
  "plan-draft",
  "implement",
  "validate",
  "resume",
  "status",
  "gc",
  "next",
  "resolve",
  "backlog",
  "score",
]);

/**
 * Parse the args string from `/supi:harness <args>` into a structured request. The
 * command handler dispatches on the result.
 */
export interface HarnessCommandRequest {
  subcommand: string | null;
  args: string[];
}

export function parseHarnessArgs(raw: string | undefined): HarnessCommandRequest {
  if (!raw || raw.trim().length === 0) return { subcommand: null, args: [] };
  const tokens = raw.trim().split(/\s+/);
  const head = tokens[0];
  if (SUBCOMMANDS.has(head)) {
    return { subcommand: head, args: tokens.slice(1) };
  }
  // Unknown subcommand: treat as part of args, no subcommand selected.
  return { subcommand: null, args: tokens };
}

/**
 * Top-level dispatcher. The implementation of each subcommand is intentionally compact:
 * the stage runners and queue helpers do the work; this function maps args to calls.
 *
 * The dispatcher is async-fire-and-forget by convention — TUI handlers do not await it.
 * Errors are surfaced via `notifyError`.
 */
export async function handleHarness(
  platform: Platform,
  ctx: HarnessCommandContext,
  rawArgs?: string,
): Promise<void> {
  const request = parseHarnessArgs(rawArgs);
  try {
    switch (request.subcommand) {
      case null:
        await handleBareEntry(platform, ctx);
        return;
      case "status":
        await handleStatus(platform, ctx);
        return;
      case "score":
        await handleScore(platform, ctx);
        return;
      case "next":
        await handleNext(platform, ctx);
        return;
      case "resolve":
        await handleResolve(platform, ctx, request.args[0]);
        return;
      case "backlog":
        await handleBacklog(platform, ctx);
        return;
      case "gc":
        await handleGc(platform, ctx);
        return;
      case "discover":
        await handleStageCommand(platform, ctx, "discover", request.args);
        return;
      case "research":
        await handleStageCommand(platform, ctx, "research", request.args);
        return;
      case "design":
        await handleStageCommand(platform, ctx, "design", request.args);
        return;
      case "plan-draft":
        await handleStageCommand(platform, ctx, "plan", request.args);
        return;
      case "implement":
        await handleStageCommand(platform, ctx, "implement", request.args);
        return;
      case "validate":
        await handleStageCommand(platform, ctx, "validate", request.args);
        return;
      case "resume":
        await handleResume(platform, ctx, request.args);
        return;
      default:
        notifyError(
          ctx,
          "Unknown harness subcommand",
          `\`${request.subcommand}\` is not a recognized /supi:harness subcommand.`,
        );
        return;
    }
  } catch (error) {
    notifyError(ctx, "Harness command failed", error instanceof Error ? error.message : String(error));
  }
}

async function handleBareEntry(platform: Platform, ctx: HarnessCommandContext): Promise<void> {
  const marker = loadMarker(platform.paths, ctx.cwd);
  if (marker) {
    notifyInfo(ctx, "Harness already installed", describeMarker(marker));
  } else {
    notifyInfo(
      ctx,
      "No harness installed",
      "Run `/supi:harness discover` to begin (or follow the prompts in `/supi:harness`).",
    );
  }
}

async function handleStatus(platform: Platform, ctx: HarnessCommandContext): Promise<void> {
  const marker = loadMarker(platform.paths, ctx.cwd);
  notifyInfo(ctx, "Harness status", describeMarker(marker));
  if (!marker) return;
  const queue = readSlopQueue(platform.paths, ctx.cwd);
  if (queue.ok) {
    const open = queue.value.filter((e) => e.state === "open").length;
    const resolved = queue.value.filter((e) => e.state === "resolved").length;
    notifyInfo(ctx, "Slop queue", `${open} open, ${resolved} resolved (total ${queue.value.length})`);
  }
}

async function handleScore(platform: Platform, ctx: HarnessCommandContext): Promise<void> {
  const queue = readSlopQueue(platform.paths, ctx.cwd);
  if (!queue.ok) {
    notifyError(ctx, "Score unavailable", queue.error.message);
    return;
  }
  const score = computeScore({ computedAt: new Date().toISOString(), entries: queue.value });
  notifyInfo(ctx, "Harness score", `lenient ${score.lenient} / strict ${score.strict}`);
}

async function handleNext(platform: Platform, ctx: HarnessCommandContext): Promise<void> {
  const result = nextQueueEntry(platform.paths, ctx.cwd);
  if (!result.ok) {
    notifyError(ctx, "Queue read failed", result.error.message);
    return;
  }
  if (!result.value) {
    notifyInfo(ctx, "Slop queue empty", "Nothing to triage.");
    return;
  }
  const entry = result.value;
  const range = entry.range ? `:${entry.range.startLine}` : "";
  notifyInfo(
    ctx,
    `Next: ${entry.id}`,
    `[${entry.severity}] ${entry.kind} at ${entry.file}${range} — ${entry.message}`,
  );
}

async function handleResolve(
  platform: Platform,
  ctx: HarnessCommandContext,
  id: string | undefined,
): Promise<void> {
  if (!id) {
    notifyError(ctx, "Missing id", "Usage: /supi:harness resolve <id>");
    return;
  }
  const result = resolveQueueEntry(platform.paths, ctx.cwd, id);
  if (!result.ok) {
    notifyError(ctx, "Resolve failed", result.error.message);
    return;
  }
  if (!result.value) {
    notifyError(ctx, "Resolve failed", `id ${id} not found in queue`);
    return;
  }
  notifyInfo(ctx, `Resolved ${id}`, `${result.value.kind} at ${result.value.file}`);
}

async function handleBacklog(platform: Platform, ctx: HarnessCommandContext): Promise<void> {
  const result = readBacklog(platform.paths, ctx.cwd);
  if (!result.ok) {
    notifyError(ctx, "Backlog read failed", result.error.message);
    return;
  }
  if (result.value.length === 0) {
    notifyInfo(ctx, "Backlog empty", "Queue has no open entries.");
    return;
  }
  const summary = result.value
    .slice(0, 10)
    .map((e) => `${e.id} ${e.severity.padEnd(7)} ${e.kind.padEnd(15)} ${e.file}`)
    .join("\n");
  const more = result.value.length > 10 ? `\n…and ${result.value.length - 10} more.` : "";
  notifyInfo(ctx, `Backlog (${result.value.length})`, summary + more);
}

async function handleGc(_platform: Platform, ctx: HarnessCommandContext): Promise<void> {
  // The full GC requires a backend adapter wired with the user's selection; v1 surfaces
  // a notification and points to the queue tools.
  notifyInfo(
    ctx,
    "/supi:harness gc",
    "v1 GC drives the queue manually via /supi:harness next + resolve. Auto-fix dispatch lands with the backend adapters once the user has run /supi:harness design and selected a backend.",
  );
}

export function registerHarnessCommand(platform: Platform): void {
  platform.registerCommand("supi:harness", {
    description: "Install or maintain the harness pipeline (anti-slop guardrails, agent-neutral docs, structural tests).",
    async handler(args: string | undefined, ctx: HarnessCommandContext) {
      await handleHarness(platform, ctx, args);
    },
  });
}
// ---------------------------------------------------------------------------
// Per-stage subcommands
// ---------------------------------------------------------------------------

/**
 * Pipeline-driver injection point. Tests substitute `runHarnessPipelineUntilGate`
 * with a stub via `setHarnessPipelineDriver` so handler logic can be exercised in
 * isolation.
 */
type PipelineDriver = typeof runHarnessPipelineUntilGate;
let pipelineDriver: PipelineDriver = runHarnessPipelineUntilGate;

export function setHarnessPipelineDriver(driver: PipelineDriver | null): void {
  pipelineDriver = driver ?? runHarnessPipelineUntilGate;
}

const SESSION_ID_PATTERN = /^harness-[0-9a-z]+-[0-9a-f]+$/;

function parseSessionFlag(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--session" && i + 1 < args.length) {
      return args[i + 1];
    }
    if (args[i].startsWith("--session=")) {
      return args[i].slice("--session=".length);
    }
  }
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function projectName(cwd: string): string {
  return path.basename(cwd) || "harness";
}

function freshSession(sessionId: string, cwd: string, stage: HarnessStage): HarnessSession {
  const ts = nowIso();
  return {
    sessionId,
    projectName: projectName(cwd),
    startedAt: ts,
    updatedAt: ts,
    stage,
    stageStatus: "pending",
    gateMode: "default",
    iteration: 1,
    blocker: null,
    artifacts: {},
  };
}

/**
 * Resolve the session id for a per-stage subcommand. When `autoCreate` is true and
 * no session exists, generate a fresh one and persist its manifest.
 */
export interface ResolveSessionResult {
  sessionId: string;
  created: boolean;
}

export function resolveHarnessSessionId(
  paths: PlatformPaths,
  cwd: string,
  args: string[],
  options: { autoCreate: boolean; stage: HarnessStage },
): ResolveSessionResult | { error: string } {
  const explicit = parseSessionFlag(args);
  if (explicit) {
    if (!SESSION_ID_PATTERN.test(explicit)) {
      return { error: `invalid session id "${explicit}" — expected harness-<base36>-<6 hex>` };
    }
    return { sessionId: explicit, created: false };
  }
  const existing = listHarnessSessions(paths, cwd);
  if (existing.length > 0) {
    return { sessionId: existing[0], created: false };
  }
  if (!options.autoCreate) {
    return { error: "no harness session found — run `/supi:harness discover` first or pass --session <id>" };
  }
  const sessionId = newHarnessSessionId();
  const persisted = saveHarnessSession(paths, cwd, freshSession(sessionId, cwd, options.stage));
  if (!persisted.ok) {
    return { error: `unable to persist session manifest: ${persisted.error.message}` };
  }
  return { sessionId, created: true };
}

/**
 * Build the BuildRunnerInput for a given stage from artifacts on disk + sensible defaults.
 * Returns either the input or a structured error message for the caller to surface.
 */
function buildStageInputs(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stage: HarnessStage,
): { input: BuildRunnerInput } | { error: string } {
  switch (stage) {
    case "discover":
    case "research":
    case "plan":
      return { input: {} };
    case "design": {
      const existingSpec = loadHarnessDesignSpecJson(paths, cwd, sessionId);
      if (existingSpec.ok) {
        return { input: { designInput: { spec: existingSpec.value } } };
      }
      const discover = loadHarnessDiscover(paths, cwd, sessionId);
      if (!discover.ok) {
        return {
          error:
            "design requires a completed discover stage. Run `/supi:harness discover` first.",
        };
      }
      const spec = defaultDesignSpecFromDiscover(discover.value, sessionId, nowIso());
      return { input: { designInput: { spec } } };
    }
    case "implement": {
      const planName = `harness-${sessionId}.md`;
      const plansDir = getProjectStatePath(paths, cwd, "plans");
      const planPath = path.join(plansDir, planName);
      // Check the file directly via fs rather than `listPlans` so this code path is
      // immune to test-suite-wide `mock.module(".../storage/plans.js", ...)` overrides.
      if (!fs.existsSync(planPath)) {
        return {
          error: `implement requires plan ${planName} under ${plansDir}. Run \`/supi:harness plan-draft\` first.`,
        };
      }
      const threshold =
        DEFAULT_HARNESS_CONFIG.implement_in_session_threshold ?? 10;
      return { input: { implementInput: { planPath, threshold } } };
    }
    case "validate": {
      const designResult = loadHarnessDesignSpecJson(paths, cwd, sessionId);
      if (!designResult.ok) {
        return {
          error:
            "validate requires a completed design stage. Run `/supi:harness design` first.",
        };
      }
      const spec = designResult.value;
      const adapter = buildBackendAdapter(spec.antiSlop.backend);
      return {
        input: {
          validateInput: {
            backend: spec.antiSlop.backend,
            adapter: adapter ?? undefined,
            scoreFloor: spec.antiSlop.hooks.score_floor,
            hooks: spec.antiSlop.hooks,
          },
        },
      };
    }
  }
}

function summarizeOutcome(outcome: PipelineRunOutcome): string {
  const tail = outcome.message ? ` — ${outcome.message}` : "";
  return `stage=${outcome.stage} status=${outcome.status}${outcome.promoted ? " (promoted)" : ""}${tail}`;
}

/**
 * Drive a single stage subcommand end-to-end: resolve the session, build inputs, load
 * the model config, invoke the pipeline driver, surface the result.
 */
export async function handleStageCommand(
  platform: Platform,
  ctx: HarnessCommandContext,
  stage: HarnessStage,
  args: string[],
): Promise<void> {
  const autoCreate = stage === "discover";
  const resolved = resolveHarnessSessionId(platform.paths, ctx.cwd, args, {
    autoCreate,
    stage,
  });
  if ("error" in resolved) {
    notifyError(ctx, `/supi:harness ${stage}`, resolved.error);
    return;
  }
  const built = buildStageInputs(platform.paths, ctx.cwd, resolved.sessionId, stage);
  if ("error" in built) {
    notifyError(ctx, `/supi:harness ${stage}`, built.error);
    return;
  }
  if (resolved.created) {
    notifyInfo(
      ctx,
      `Started session ${resolved.sessionId}`,
      `Fresh harness session created for stage ${stage}.`,
    );
  }
  if (stage === "design" && !loadHarnessDesignSpecJson(platform.paths, ctx.cwd, resolved.sessionId).ok) {
    notifyInfo(
      ctx,
      "Using default design spec",
      "Edit `<session>/design-spec.json` to customize, then re-run `/supi:harness design`.",
    );
  }
  const modelConfig = loadModelConfig(platform.paths, ctx.cwd);
  const outcome = await pipelineDriver({
    platform,
    paths: platform.paths,
    cwd: ctx.cwd,
    sessionId: resolved.sessionId,
    modelConfig,
    // Per-stage subcommand semantics: run exactly one stage and stop. Without `manual`
    // gates the pipeline transits through non-gate stages (e.g. research → design) and
    // attempts to construct downstream runners without their stage inputs.
    gates: "manual",
    stageInputs: built.input,
    startStage: stage,
  });
  const headline = `/supi:harness ${stage}`;
  if (outcome.status === "failed") {
    notifyError(ctx, headline, summarizeOutcome(outcome));
    return;
  }
  if (outcome.status === "blocked") {
    notifyError(ctx, headline, summarizeOutcome(outcome));
    return;
  }
  notifyInfo(ctx, headline, summarizeOutcome(outcome));
}

async function handleResume(
  platform: Platform,
  ctx: HarnessCommandContext,
  args: string[],
): Promise<void> {
  const explicit = parseSessionFlag(args);
  const sessions = listHarnessSessions(platform.paths, ctx.cwd);
  if (sessions.length === 0) {
    notifyInfo(
      ctx,
      "/supi:harness resume",
      "No harness sessions found. Run `/supi:harness discover` to start one.",
    );
    return;
  }
  const target = explicit ?? sessions[0];
  const session = loadHarnessSession(platform.paths, ctx.cwd, target);
  if (!session.ok) {
    notifyError(
      ctx,
      "/supi:harness resume",
      `Unable to load session ${target}: ${session.error.message}`,
    );
    return;
  }
  const next = nextSubcommandFor(session.value.stage, session.value.stageStatus);
  notifyInfo(
    ctx,
    `Resume ${target}`,
    `stage=${session.value.stage} status=${session.value.stageStatus}. Run \`/supi:harness ${next}\` to continue.`,
  );
}

function nextSubcommandFor(
  stage: HarnessSession["stage"],
  status: HarnessSession["stageStatus"],
): string {
  // If the current stage is awaiting-user, repeat it; otherwise advance.
  if (status === "awaiting-user" || status === "blocked") {
    return cliNameFor(stage);
  }
  switch (stage) {
    case "discover":
      return "research";
    case "research":
      return "design";
    case "design":
      return "plan-draft";
    case "plan":
      return "implement";
    case "implement":
      return "validate";
    case "validate":
      return "validate";
  }
}

function cliNameFor(stage: HarnessSession["stage"]): string {
  return stage === "plan" ? "plan-draft" : stage;
}
