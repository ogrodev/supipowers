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
import { getMetricsStore, getSessionId } from "../context-mode/hooks.js";
import { getProjectStateDir } from "../workspace/state-paths.js";
import { formatSize } from "../context/analyzer.js";

const SCOPE_SENTENCE =
  "Scope: metrics only. Events, knowledge, and cache are not touched.";

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

/** Build the active-session deletion summary text. */
function buildActiveSessionSummary(
  store: ReturnType<typeof getMetricsStore>,
  sessionId: string,
): string {
  if (!store) return `No metrics store available. ${SCOPE_SENTENCE}`;
  const totals = store.getSessionTotals(sessionId);
  const meta = store.getSessionMeta(sessionId);
  const rels = formatRelativeTime(meta?.started_at ?? null);
  // Use afterBytes as the "displayed disk estimate" — the bytes the agent
  // currently sees, which is the most defensible number to show users.
  const onDisk = formatSize(totals.afterBytes);
  return [
    `${totals.rowCount} metrics rows in this session.`,
    `Approx on-disk: ${onDisk}.`,
    `Started: ${rels}.`,
    SCOPE_SENTENCE,
    `Metrics DB: ${store.dbPath}`,
  ].join("\n");
}

/** Build the project-wide deletion summary listing every session id. */
function buildProjectSummary(
  store: ReturnType<typeof getMetricsStore>,
  projectSlug: string,
): { summary: string; sessionLines: string[] } {
  if (!store) {
    return {
      summary: `No metrics store available. ${SCOPE_SENTENCE}`,
      sessionLines: [],
    };
  }
  const sessions = store.listSessions(projectSlug);
  const sessionLines = sessions.map(
    (s) => `${s.session_id} \u2014 ${s.row_count} rows, started ${formatRelativeTime(s.started_at)}`,
  );
  const summary = [
    `Project-wide clear: ${sessions.length} session${sessions.length === 1 ? "" : "s"}.`,
    SCOPE_SENTENCE,
    `Metrics DB: ${store.dbPath}`,
  ].join("\n");
  return { summary, sessionLines };
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
    const projectSlug = basename(getProjectStateDir(platform.paths, ctx.cwd));

    if (scope === "session") {
      const summary = buildActiveSessionSummary(store, sessionId);
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

      if (!store) {
        ctx.ui.notify(
          "Nothing to clear: metrics store is not initialized.",
          "info",
        );
        return;
      }

      try {
        store.clearSession(sessionId);
        ctx.ui.notify("Metrics cleared for this session.", "info");
      } catch (e) {
        ctx.ui.notify(
          `Clear failed: ${(e as Error).message}. See /supi:doctor.`,
          "error",
        );
      }
      return;
    }

    // scope === "project"
    const { summary, sessionLines } = buildProjectSummary(store, projectSlug);
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

    if (!store) {
      ctx.ui.notify(
        "Nothing to clear: metrics store is not initialized.",
        "info",
      );
      return;
    }

    try {
      store.clearProject(projectSlug);
      ctx.ui.notify("Metrics cleared project-wide.", "info");
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
    description: "Clear L1 metrics for the active session (or `all` for the project)",
    async handler(args: string | undefined, ctx: any) {
      handleClear(platform, ctx, args);
    },
  });
}
