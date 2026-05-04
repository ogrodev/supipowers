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

import type { Platform } from "../platform/types.js";
import { notifyError, notifyInfo } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { isHarnessInstalled, loadMarker, describeMarker } from "./bare-entry.js";
import {
  backlog as readBacklog,
  next as nextQueueEntry,
  resolve as resolveQueueEntry,
} from "./anti_slop/queue.js";
import {
  loadHarnessSession,
  readSlopQueue,
} from "./storage.js";
import { computeScore } from "./anti_slop/score.js";

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
      default:
        // Stage-running subcommands (discover/research/design/plan-draft/implement/validate/resume)
        // are wired into the pipeline driver; v1 surfaces them as TODO with a redirect to
        // /supi:harness for the bare-entry flow.
        notifyInfo(
          ctx,
          `/supi:harness ${request.subcommand}`,
          `${request.subcommand} runs through the pipeline driver. v1 surfaces this through the bare-entry flow; per-stage CLI subcommands will land alongside test coverage in the harness command file.`,
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

// Note: loadHarnessSession is exported here so the command file can verify a session
// before driving the pipeline. We keep the import even when not directly used in this
// dispatcher v1 so future per-stage subcommands have it pre-wired.
void loadHarnessSession;
void isHarnessInstalled;
