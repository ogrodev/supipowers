// src/commands/clear.ts
//
// `/supi:clear` — destructive, scoped to L1 metrics rows only. Cross-store
// deletion (events / knowledge / cache) is intentionally out of scope; a
// future spec covers that when L3 lands.
//
// UX rules (from L1 design spec §6.4 + plan Tasks 39\u201347):
//   - Pre-deletion summary is rendered before any prompt.
//   - The exact scope sentence is included verbatim so the user has full
//     clarity on what is and is not being touched.
//   - Confirmation falls back to `ctx.ui.select` when `ctx.ui.confirm` is
//     absent (mirrors `optimize-context.ts` pattern).
//   - Headless invocations (`!ctx.hasUI`) return silently; programmatic
//     non-TUI variants are explicitly out of scope.

import type { Platform, PlatformContext } from "../platform/types.js";
import { basename } from "node:path";
import { getCacheStore, getMetricsStore, getSessionId } from "../context-mode/hooks.js";
import { getProjectStateDir } from "../workspace/state-paths.js";
import { formatSize } from "../context/analyzer.js";

const SESSION_SCOPE_SENTENCE =
  "Scope: metrics and cache for this session. Events and knowledge are not touched.";
const PROJECT_SCOPE_SENTENCE =
  "Scope: metrics and cache for this project. Events and knowledge are not touched.";

function formatRelativeTime(startedAtMs: number | null, now = Date.now()): string {
  if (startedAtMs === null) return "unknown";
  const delta = Math.max(0, now - startedAtMs);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Confirmation helper that prefers `ctx.ui.confirm` when available, falling
 *  back to `ctx.ui.select(title, ["Confirm", "Cancel"], { helpText: summary })`.
 *  Mirrors the pattern in `optimize-context.ts:109`. */
async function confirmDestructive(
  ctx: PlatformContext,
  title: string,
  summary: string,
): Promise<boolean> {
  const confirm = (ctx.ui as any).confirm;
  if (typeof confirm === "function") {
    return Boolean(await confirm.call(ctx.ui, title, summary));
  }
  const choice = await ctx.ui.select(title, ["Confirm", "Cancel"], {
    helpText: summary,
  });
  return choice === "Confirm";
}

function recordCacheClearMetric(
  store: ReturnType<typeof getMetricsStore>,
  sessionId: string,
  beforeBytes: number,
  afterBytes = 0,
  now = Date.now(),
): void {
  if (!store) return;
  try {
    store.record({
      session_id: "(system)",
      ts: now,
      layer: "L3",
      tool: "(system)",
      processor: "cache-clear",
      before_bytes: Math.max(0, Math.floor(beforeBytes)),
      after_bytes: Math.max(0, Math.floor(afterBytes)),
      cache_hit: 0,
      unique_source_hash: null,
      context_tokens: null,
      context_window: null,
      context_percent: null,
    });
  } catch {
    // Clearing must not depend on metrics health.
  }
}

/** Build the active-session deletion summary text. */
function buildActiveSessionSummary(
  store: ReturnType<typeof getMetricsStore>,
  cacheStore: ReturnType<typeof getCacheStore>,
  sessionId: string,
): string {
  const lines: string[] = [];
  if (store) {
    const totals = store.getSessionTotals(sessionId);
    const meta = store.getSessionMeta(sessionId);
    const rels = formatRelativeTime(meta?.started_at ?? null);
    const onDisk = formatSize(totals.afterBytes);
    lines.push(
      `${totals.rowCount} metrics rows in this session.`,
      `Approx on-disk: ${onDisk}.`,
      `Started: ${rels}.`,
      `Metrics DB: ${store.dbPath}`,
    );
  } else {
    lines.push("No metrics store available.");
  }

  if (cacheStore) {
    const cache = cacheStore.getSessionStats(sessionId);
    lines.push(
      `${cache.refCount} cache refs in this session.`,
      `Cache payload bytes reclaimable: ${cache.reclaimablePayloadBytes} bytes (${formatSize(cache.reclaimablePayloadBytes)}).`,
      `Cache payload bytes retained: ${cache.retainedPayloadBytes} bytes (${formatSize(cache.retainedPayloadBytes)}).`,
      `Cache DB: ${cacheStore.dbPath}`,
      `Cache payloads: ${cacheStore.payloadRoot}`,
    );
  } else {
    lines.push("No cache store available.");
  }

  lines.push(SESSION_SCOPE_SENTENCE);
  return lines.join("\n");
}

/** Build the project-wide deletion summary listing every session id. */
function buildProjectSummary(
  store: ReturnType<typeof getMetricsStore>,
  cacheStore: ReturnType<typeof getCacheStore>,
  projectSlug: string,
): { summary: string; sessionLines: string[] } {
  const lines: string[] = [];
  const metricsSessionRows = store ? store.listSessions(projectSlug) : [];
  const cacheSessionRows = cacheStore ? cacheStore.listSessions() : [];

  // Merge metrics + cache sessions so the second confirmation is truthful when
  // cache refs exist for sessions that have no metrics rows.
  const seen = new Set<string>();
  const sessionLines: string[] = [];
  for (const s of metricsSessionRows) {
    seen.add(s.session_id);
    const cacheRow = cacheSessionRows.find((c) => c.session_id === s.session_id);
    const cacheSuffix = cacheRow ? `, ${cacheRow.ref_count} cache refs` : "";
    sessionLines.push(
      `${s.session_id} \u2014 ${s.row_count} rows${cacheSuffix}, started ${formatRelativeTime(s.started_at)}`,
    );
  }
  for (const c of cacheSessionRows) {
    if (seen.has(c.session_id)) continue;
    sessionLines.push(`${c.session_id} \u2014 cache only (${c.ref_count} refs)`);
  }

  if (store) {
    lines.push(
      `Project-wide clear: ${metricsSessionRows.length} session${metricsSessionRows.length === 1 ? "" : "s"} with metrics rows.`,
      `Metrics DB: ${store.dbPath}`,
    );
  } else {
    lines.push("No metrics store available.");
  }

  if (cacheStore) {
    const cache = cacheStore.getStats();
    lines.push(
      `${cache.refCount} cache refs project-wide across ${cacheSessionRows.length} session${cacheSessionRows.length === 1 ? "" : "s"}.`,
      `${cache.entryCount} cache entries project-wide.`,
      `Cache payload bytes: ${cache.payloadBytes} bytes (${formatSize(cache.payloadBytes)}).`,
      `Cache DB: ${cacheStore.dbPath}`,
      `Cache payloads: ${cacheStore.payloadRoot}`,
    );
  } else {
    lines.push("No cache store available.");
  }

  lines.push(PROJECT_SCOPE_SENTENCE);
  return { summary: lines.join("\n"), sessionLines };
}

interface ParsedArgs {
  scope: "session" | "project";
  dryRun: boolean;
}

function parseArgs(args: string | undefined): ParsedArgs {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const dryRun = tokens.includes("--dry-run");
  const scope = tokens.includes("all") ? "project" : "session";
  return { scope, dryRun };
}

export function handleClear(
  platform: Platform,
  ctx: PlatformContext,
  args?: string,
): void {
  if (!ctx.hasUI) return;

  void (async () => {
    const { scope, dryRun } = parseArgs(args);
    const store = getMetricsStore();
    const sessionId = getSessionId();
    const cacheStore = getCacheStore();
    const projectSlug = basename(getProjectStateDir(platform.paths, ctx.cwd));

    if (scope === "session") {
      const summary = buildActiveSessionSummary(store, cacheStore, sessionId);
      ctx.ui.notify(summary, "info");

      if (dryRun) {
        ctx.ui.notify("Dry-run: nothing was deleted.", "info");
        return;
      }

      const accepted = await confirmDestructive(
        ctx,
        "Clear metrics for this session?",
        summary,
      );
      if (!accepted) {
        ctx.ui.notify("Clear cancelled.", "info");
        return;
      }

      if (!store && !cacheStore) {
        ctx.ui.notify(
          "Nothing to clear: metrics and cache stores are not initialized.",
          "info",
        );
        return;
      }

      try {
        if (store) {
          store.clearSession(sessionId);
        }
        if (cacheStore) {
          const cacheResult = cacheStore.clearSession(sessionId);
          // Record an L3 cache-clear metric reflecting what actually happened:
          // before = total payload bytes referenced by this session;
          // after  = bytes retained because other sessions still reference them.
          recordCacheClearMetric(
            store,
            sessionId,
            cacheResult.deletedPayloadBytes + cacheResult.retainedPayloadBytes,
            cacheResult.retainedPayloadBytes,
          );
          if (cacheResult.retainedPayloadBytes > 0) {
            ctx.ui.notify(
              `Metrics and cache cleared for this session. ${formatSize(cacheResult.retainedPayloadBytes)} retained for other sessions.`,
              "info",
            );
          } else {
            ctx.ui.notify("Metrics and cache cleared for this session.", "info");
          }
        } else {
          ctx.ui.notify("Metrics cleared for this session. (No cache store active.)", "info");
        }
      } catch (e) {
        ctx.ui.notify(
          `Clear failed: ${(e as Error).message}. See /supi:doctor.`,
          "error",
        );
      }
      return;
    }

    // scope === "project"
    const { summary, sessionLines } = buildProjectSummary(store, cacheStore, projectSlug);
    ctx.ui.notify(summary, "info");

    if (dryRun) {
      ctx.ui.notify("Dry-run: nothing was deleted.", "info");
      return;
    }

    const firstAccept = await confirmDestructive(
      ctx,
      "Clear metrics for the entire project?",
      summary,
    );
    if (!firstAccept) {
      ctx.ui.notify("Clear cancelled.", "info");
      return;
    }

    // Second confirm: list every session so the user sees exactly what
    // disappears.
    const finalChoice = await ctx.ui.select(
      "Confirm project-wide clear",
      ["Confirm", "Cancel"],
      {
        helpText:
          sessionLines.length > 0
            ? `The following sessions will be cleared:\n${sessionLines.join("\n")}`
            : "(no sessions tracked)",
      },
    );
    if (finalChoice !== "Confirm") {
      ctx.ui.notify("Clear cancelled.", "info");
      return;
    }

    if (!store && !cacheStore) {
      ctx.ui.notify(
        "Nothing to clear: metrics and cache stores are not initialized.",
        "info",
      );
      return;
    }

    try {
      if (store) {
        store.clearProject(projectSlug);
      }
      if (cacheStore) {
        const cacheResult = cacheStore.clearProject();
        // Project-wide clear deletes every cache ref, so retained bytes are always 0.
        recordCacheClearMetric(store, sessionId, cacheResult.deletedPayloadBytes, 0);
      }
      ctx.ui.notify("Metrics and cache cleared project-wide.", "info");
    } catch (e) {
      ctx.ui.notify(
        `Clear failed: ${(e as Error).message}. See /supi:doctor.`,
        "error",
      );
    }
  })().catch((err) => {
    ctx.ui.notify(`Clear error: ${(err as Error).message}`, "error");
  });
}

export function registerClearCommand(platform: Platform): void {
  platform.registerCommand("supi:clear", {
    description: "Clear L1 metrics and L3 cache for the active session (or `all` for the project)",
    async handler(args: string | undefined, ctx: any) {
      handleClear(platform, ctx, args);
    },
  });
}
