// src/commands/clear.ts
//
// `/supi:clear` — destructive cleanup for metrics, cache, current-session
// knowledge, and memory. Events are intentionally out of scope.
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
import { getCacheStore, getKnowledgeStore, getMetricsStore, getSessionId } from "../context-mode/hooks.js";
import { getMemoryStore } from "../context-mode/memory-store.js";
import { getProjectStateDir } from "../workspace/state-paths.js";
import { formatSize } from "../context/analyzer.js";

const SESSION_SCOPE_SENTENCE =
  "Scope: metrics, cache, current-session knowledge, and current-session memory. Project memory created before this clear is suppressed for this session. Events are not touched.";
const PROJECT_SCOPE_SENTENCE =
  "Scope: metrics, cache, all indexed knowledge, and all memory for this project. Events are not touched.";

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
  knowledgeStore: ReturnType<typeof getKnowledgeStore>,
  memoryStore: ReturnType<typeof getMemoryStore>,
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

  if (knowledgeStore) {
    lines.push(
      `Knowledge DB: ${knowledgeStore.path}`,
      "Current-session indexed knowledge will be cleared.",
    );
  } else {
    lines.push("No knowledge store available.");
  }

  if (memoryStore) {
    const sessionRows = memoryStore.countSessionRows(sessionId);
    lines.push(
      `Memory DB: ${memoryStore.dbPath}`,
      `${sessionRows} session-owned memory rows for this session will be cleared; project memory remains.`,
    );
  } else {
    lines.push("No memory store available.");
  }

  lines.push(SESSION_SCOPE_SENTENCE);
  return lines.join("\n");
}

/** Build the project-wide deletion summary listing every session id. */
function buildProjectSummary(
  store: ReturnType<typeof getMetricsStore>,
  cacheStore: ReturnType<typeof getCacheStore>,
  knowledgeStore: ReturnType<typeof getKnowledgeStore>,
  memoryStore: ReturnType<typeof getMemoryStore>,
  projectSlug: string,
): { summary: string; sessionLines: string[] } {
  const lines: string[] = [];
  const metricsSessionRows = store ? store.listSessions(projectSlug) : [];
  const cacheSessionRows = cacheStore ? cacheStore.listSessions() : [];
  const knowledgeSessionRows = knowledgeStore ? knowledgeStore.listSessions() : [];
  const memorySessionRows = memoryStore ? memoryStore.listSessions() : [];

  // Merge metrics + cache + knowledge + memory sessions so the second
  // destructive confirmation lists every session with data that will disappear.
  const sessionMap = new Map<string, {
    session_id: string;
    metricsRows?: number;
    startedAt?: number;
    cacheRefs?: number;
    knowledgeChunks?: number;
    knowledgeUrlCache?: number;
    memoryRows?: number;
  }>();
  const ensureSession = (sessionId: string) => {
    let row = sessionMap.get(sessionId);
    if (!row) {
      row = { session_id: sessionId };
      sessionMap.set(sessionId, row);
    }
    return row;
  };

  for (const s of metricsSessionRows) {
    const row = ensureSession(s.session_id);
    row.metricsRows = s.row_count;
    row.startedAt = s.started_at;
  }
  for (const c of cacheSessionRows) {
    ensureSession(c.session_id).cacheRefs = c.ref_count;
  }
  for (const k of knowledgeSessionRows) {
    const row = ensureSession(k.session_id);
    row.knowledgeChunks = k.chunk_count;
    row.knowledgeUrlCache = k.url_cache_count;
  }
  for (const m of memorySessionRows) {
    ensureSession(m.session_id).memoryRows = m.row_count;
  }

  const sessionLines = [...sessionMap.values()]
    .sort((a, b) => a.session_id.localeCompare(b.session_id))
    .map((s) => {
      const parts: string[] = [];
      if (s.metricsRows !== undefined) {
        parts.push(`${s.metricsRows} metrics rows`);
        if (s.startedAt !== undefined) parts.push(`started ${formatRelativeTime(s.startedAt)}`);
      }
      if (s.cacheRefs !== undefined) parts.push(`${s.cacheRefs} cache refs`);
      if (s.knowledgeChunks !== undefined || s.knowledgeUrlCache !== undefined) {
        parts.push(`${s.knowledgeChunks ?? 0} knowledge chunks`);
        if ((s.knowledgeUrlCache ?? 0) > 0) parts.push(`${s.knowledgeUrlCache} URL cache rows`);
      }
      if (s.memoryRows !== undefined) parts.push(`${s.memoryRows} memory rows`);
      return `${s.session_id} — ${parts.join(", ")}`;
    });

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

  if (knowledgeStore) {
    const knowledgeStats = knowledgeStore.getStats();
    lines.push(
      `${knowledgeStats.totalChunks} indexed knowledge chunks project-wide.`,
      "All indexed knowledge scopes, including legacy rows, will be cleared.",
    );
  } else {
    lines.push("No knowledge store available.");
  }

  if (memoryStore) {
    const stats = memoryStore.getStats();
    lines.push(
      `Memory DB: ${memoryStore.dbPath}`,
      `${stats.totalRows} memory rows project-wide will be cleared (session: ${stats.sessionRows}, project: ${stats.projectRows}).`,
    );
  } else {
    lines.push("No memory store available.");
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
    const knowledgeStore = getKnowledgeStore();
    const memoryStore = getMemoryStore();
    const projectSlug = basename(getProjectStateDir(platform.paths, ctx.cwd));

    if (scope === "session") {
      const summary = buildActiveSessionSummary(store, cacheStore, knowledgeStore, memoryStore, sessionId);
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

      if (!store && !cacheStore && !knowledgeStore && !memoryStore) {
        ctx.ui.notify(
          "Nothing to clear: metrics, cache, knowledge, and memory stores are not initialized.",
          "info",
        );
        return;
      }

      try {
        if (store) {
          store.clearSession(sessionId);
        }
        if (knowledgeStore) {
          knowledgeStore.clearSession(sessionId);
        }
        if (memoryStore) {
          memoryStore.clearSession(sessionId);
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
              `Metrics, cache, and current-session knowledge cleared for this session. ${formatSize(cacheResult.retainedPayloadBytes)} retained for other sessions.`,
              "info",
            );
          } else {
            ctx.ui.notify("Metrics, cache, and current-session knowledge cleared for this session.", "info");
          }
        } else {
          ctx.ui.notify("Metrics and current-session knowledge cleared for this session. (No cache store active.)", "info");
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
    const { summary, sessionLines } = buildProjectSummary(store, cacheStore, knowledgeStore, memoryStore, projectSlug);
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

    if (!store && !cacheStore && !knowledgeStore && !memoryStore) {
      ctx.ui.notify(
        "Nothing to clear: metrics, cache, knowledge, and memory stores are not initialized.",
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
      if (knowledgeStore) {
        knowledgeStore.clearProject();
      }
      if (memoryStore) {
        memoryStore.clearProject();
      }
      ctx.ui.notify("Metrics, cache, indexed knowledge, and memory cleared project-wide.", "info");
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
    description: "Clear metrics, cache, current-session knowledge, and memory for the active session (or `all` for the project)",
    async handler(args: string | undefined, ctx: any) {
      handleClear(platform, ctx, args);
    },
  });
}
