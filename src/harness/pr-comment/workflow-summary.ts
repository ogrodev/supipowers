/**
 * Fallback writer for `$GITHUB_STEP_SUMMARY`.
 *
 * GitHub Actions reads any markdown appended to the file at this env var and renders it
 * on the workflow run summary page. We use it as a fail-open fallback when posting a PR
 * comment is impossible (no auth, no `gh` CLI, no PR context).
 *
 * Never throws. Returns `{ ok: false }` quietly on IO error so the calling pipeline does
 * not crash on a runner with an unwritable `$GITHUB_STEP_SUMMARY`.
 */

import * as fs from "node:fs";

export interface WriteStepSummaryResult {
  /** True when the body was appended (or no-op because env is unset). */
  ok: boolean;
  /** Resolved summary file path when appended. */
  path?: string;
  /** When ok=false, a short reason for diagnostics. */
  reason?: string;
}

/**
 * Append `body` to the workflow step summary file. When `$GITHUB_STEP_SUMMARY` is unset
 * (local dev), this is a successful no-op.
 */
export function writeStepSummary(
  body: string,
  env: NodeJS.ProcessEnv = process.env,
): WriteStepSummaryResult {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return { ok: true };
  }
  try {
    // The summary file is append-only between steps; we add a leading blank line so the
    // harness section is separated from anything an earlier step contributed.
    const payload = body.endsWith("\n") ? `\n${body}` : `\n${body}\n`;
    fs.appendFileSync(summaryPath, payload);
    return { ok: true, path: summaryPath };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
