/**
 * Post-session dead-code sweep.
 *
 * Registered on `agent_end`. After every turn that wrote files, runs the configured
 * backend's `deadCode` scan against changed files and appends new findings to the queue.
 *
 * The hook never blocks the session — `block_on_new_dead_code` only controls whether we
 * surface a warning steer message back to the user. Even when surfacing, we do not
 * replace `agent_end` with `awaiting-user` semantics; we simply notify.
 */

import * as fs from "node:fs";

import type { Platform } from "../../platform/types.js";
import type { HarnessHookConfig, HarnessSlopQueueEntry } from "../../types.js";
import { type SlopBackend } from "../anti_slop/backend.js";
import { computeQueueEntryId } from "../anti_slop/queue.js";
import { appendSlopQueueEntry } from "../storage.js";
import { getHarnessMarkerPath } from "../project-paths.js";

export interface PostSessionSweepOptions {
  adapter: SlopBackend | null;
  config: HarnessHookConfig["post_session_sweep"];
  /** Optional override for the per-turn timeout (ms). Defaults to 30 s. */
  timeoutMs?: number;
}

export interface SweepResult {
  ran: boolean;
  newFindings: number;
  durationMs: number;
  reason: string;
}

/** Run the sweep and append new findings. Pure dispatcher, used by both the live hook and tests. */
export async function runPostSessionSweep(input: {
  platform: Platform;
  cwd: string;
  adapter: SlopBackend;
  timeoutMs: number;
}): Promise<SweepResult> {
  const startedAt = Date.now();
  const result = await input.adapter.deadCode(input.platform, {
    cwd: input.cwd,
    changedSinceHead: true,
    timeoutMs: input.timeoutMs,
  });
  if (!result.ok) {
    return {
      ran: false,
      newFindings: 0,
      durationMs: Date.now() - startedAt,
      reason: `${result.reason}: ${result.message}`,
    };
  }
  let newFindings = 0;
  const ts = new Date().toISOString();
  for (const finding of result.findings) {
    if (finding.kind !== "dead-code") continue;
    const id = computeQueueEntryId({
      kind: "dead-code",
      file: finding.file,
      range: finding.range,
      ruleHint: typeof finding.details?.rule === "string" ? finding.details.rule : "post-session-sweep",
    });
    const entry: HarnessSlopQueueEntry = {
      id,
      kind: "dead-code",
      file: finding.file,
      range: finding.range,
      severity: finding.severity,
      source: finding.source,
      state: "open",
      message: finding.message,
      remediation: finding.remediation,
      ts,
      ...(finding.details ? { details: finding.details } : {}),
    };
    const persisted = appendSlopQueueEntry(input.platform.paths, input.cwd, entry);
    if (persisted.ok) newFindings += 1;
  }
  return {
    ran: true,
    newFindings,
    durationMs: Date.now() - startedAt,
    reason: newFindings > 0 ? `${newFindings} new dead-code finding(s)` : "no new findings",
  };
}

export function registerPostSessionSweepHook(
  platform: Platform,
  options: PostSessionSweepOptions,
): () => void {
  if (!options.config.enabled || options.adapter === null) {
    return () => {};
  }
  let unregistered = false;
  const adapter = options.adapter;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const handler = async (_event: unknown, ctx: unknown): Promise<void> => {
    if (unregistered) return;
    const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    if (!fs.existsSync(getHarnessMarkerPath(platform.paths, cwd))) return;
    const result = await runPostSessionSweep({
      platform,
      cwd,
      adapter,
      timeoutMs,
    });
    if (result.newFindings > 0 && options.config.block_on_new_dead_code) {
      // The block-on-new-dead-code policy is a steer message; we do NOT abort the agent.
      const message =
        `Harness sweep detected ${result.newFindings} new dead-code finding(s). Run /supi:harness backlog to inspect.`;
      try {
        platform.sendMessage(
          { customType: "supi-harness-sweep", content: [{ type: "text", text: message }], display: "none" },
          { deliverAs: "steer", triggerTurn: false },
        );
      } catch {
        // Platform may not implement sendMessage; ignore.
      }
    }
  };

  platform.on("agent_end", handler);
  return () => {
    unregistered = true;
  };
}
