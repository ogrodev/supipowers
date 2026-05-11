/**
 * Handler for `/supi:harness pr-comment`.
 *
 * Resolves a validate report → baseline → CI context → renders → posts (or writes a
 * step-summary fallback). Always notifies the UI with a one-line outcome; never throws.
 *
 * Flags (parsed via `parseFlags`):
 *   --dry-run                  Print the body to stdout/UI, no `gh` call, no env required.
 *   --pr=<n>                   Override PR number (otherwise read from env).
 *   --repo=<owner>/<repo>      Override repo (otherwise read from GITHUB_REPOSITORY).
 *   --session=<id>             Override which session's validate report we render.
 *   --mode=every-push|on-status-change
 *                              Override the config-supplied posting cadence.
 */

import type { Platform } from "../../platform/types.js";
import type { HarnessCommandContext } from "../command.js";
import {
  listHarnessSessions,
  loadHarnessDesignSpecJson,
  loadHarnessValidateReport,
} from "../storage.js";
import { renderHarnessPrComment } from "./render.js";
import { loadBaseline } from "./baseline.js";
import { detectCiContext } from "./ci-env.js";
import { postStickyComment } from "./gh-poster.js";
import { STICKY_MARKER_PREFIX } from "./status.js";
import { writeStepSummary } from "./workflow-summary.js";

interface ParsedFlags {
  dryRun: boolean;
  prNumber?: number;
  repo?: string;
  sessionId?: string;
  mode?: "every-push" | "on-status-change";
}

/** Default floor used when no design spec exists yet (purely defensive). */
const DEFAULT_SCORE_FLOOR = { strict: 75, lenient: 90 } as const;

/** Default mode when neither flag nor config supplies one. */
const DEFAULT_MODE = "every-push" satisfies NonNullable<ParsedFlags["mode"]>;

export async function handlePrComment(
  platform: Platform,
  ctx: HarnessCommandContext,
  args: readonly string[],
): Promise<void> {
  const flags = parseFlags(args);

  // 1. Pick the session.
  const sessionId = flags.sessionId ?? listHarnessSessions(platform.paths, ctx.cwd)[0];
  if (!sessionId) {
    ctx.ui.notify(
      "No harness session found. Run `/supi:harness validate` first or pass --session=<id>.",
      "error",
    );
    return;
  }

  // 2. Load the validate report.
  const reportResult = loadHarnessValidateReport(platform.paths, ctx.cwd, sessionId);
  if (!reportResult.ok) {
    ctx.ui.notify(
      `Cannot read validate report for session ${sessionId}: ${reportResult.error.message}`,
      "error",
    );
    return;
  }
  const report = reportResult.value;

  // 3. Load baseline + score floor + config-supplied mode from the design spec.
  const baseline = loadBaseline(platform.paths, ctx.cwd, { currentSessionId: sessionId });
  const designSpec = loadHarnessDesignSpecJson(platform.paths, ctx.cwd, sessionId);
  const scoreFloor = designSpec.ok ? designSpec.value.antiSlop.hooks.score_floor : DEFAULT_SCORE_FLOOR;
  const configMode = designSpec.ok ? designSpec.value.ci.prComment?.mode : undefined;
  const enabled = designSpec.ok ? designSpec.value.ci.prComment?.enabled !== false : true;
  if (!enabled && !flags.dryRun) {
    ctx.ui.notify(
      "PR comments are disabled in this harness design spec (ci.prComment.enabled=false).",
      "info",
    );
    return;
  }

  const mode = flags.mode ?? configMode ?? DEFAULT_MODE;

  // 4. CI context (flag overrides > env). For --dry-run we tolerate a missing context.
  const ciContext = detectCiContext(process.env, {
    repo: flags.repo,
    prNumber: flags.prNumber,
  });

  // 5. Render.
  const rendered = renderHarnessPrComment({
    report,
    previousScore: baseline.previousScore,
    trend: baseline.trend,
    scoreFloor: { strict: scoreFloor.strict, lenient: scoreFloor.lenient },
    sessionId,
    generatedAt: new Date().toISOString(),
    runUrl: ciContext?.runUrl,
    baseRef: ciContext?.baseRef,
  });

  // 6. Branch on transport.
  if (flags.dryRun) {
    ctx.ui.notify(`PR comment preview (status=${rendered.status}):\n\n${rendered.body}`, "info");
    return;
  }

  if (!ciContext) {
    // No PR context — fall back to the step summary unconditionally. This is the
    // expected path on `push` events that should not post a PR comment.
    const summary = writeStepSummary(rendered.body);
    if (summary.ok && summary.path) {
      ctx.ui.notify(`No PR context; wrote summary to ${summary.path}.`, "info");
    } else if (summary.ok) {
      ctx.ui.notify("Skipped: no PR context and no GITHUB_STEP_SUMMARY available.", "info");
    } else {
      ctx.ui.notify(`Skipped: ${summary.reason ?? "no PR context"}`, "warning");
    }
    return;
  }

  const outcome = await postStickyComment(platform, {
    repo: ciContext.repo,
    prNumber: ciContext.prNumber,
    cwd: ctx.cwd,
    body: rendered.body,
    mode,
    currentStatus: rendered.status,
  });

  switch (outcome.kind) {
    case "created":
      ctx.ui.notify(`PR comment created (id=${outcome.commentId}).`, "info");
      return;
    case "updated":
      ctx.ui.notify(`PR comment updated (id=${outcome.commentId}).`, "info");
      return;
    case "unchanged":
      ctx.ui.notify(`PR comment unchanged (status still ${rendered.status}, id=${outcome.commentId}).`, "info");
      return;
    case "skipped":
    case "failed": {
      // Fail-open: write the body to the workflow summary so the run page still has the
      // report, then notify with a warning (not an error — this is auxiliary signal).
      const summary = writeStepSummary(rendered.body);
      const fallback = summary.ok && summary.path ? ` (summary at ${summary.path})` : "";
      const reason = outcome.kind === "failed" ? outcome.reason : outcome.reason;
      ctx.ui.notify(`PR comment ${outcome.kind}: ${reason}.${fallback}`, "warning");
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

function parseFlags(args: readonly string[]): ParsedFlags {
  const flags: ParsedFlags = { dryRun: false };
  for (const arg of args) {
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq === -1) continue;
    const name = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    switch (name) {
      case "--pr": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) flags.prNumber = n;
        break;
      }
      case "--repo":
        flags.repo = value;
        break;
      case "--session":
        flags.sessionId = value;
        break;
      case "--mode":
        if (value === "every-push" || value === "on-status-change") flags.mode = value;
        break;
      default:
        // Unknown flag — ignored. The dispatcher already filters by subcommand name.
        break;
    }
  }
  return flags;
}

// Suppress unused-import warning for STICKY_MARKER_PREFIX — re-exported indirectly for
// downstream consumers that import from this module.
void STICKY_MARKER_PREFIX;
