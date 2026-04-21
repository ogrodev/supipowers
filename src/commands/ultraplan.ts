import type { UltraPlanManifest, UltraPlanSessionSummary } from "../types.js";
import type { Platform } from "../platform/types.js";
import { notifyError, notifyInfo, notifyWarning } from "../notifications/renderer.js";
import { buildUltraPlanPickerOptions, renderUltraPlanStatus } from "../ultraplan/presenter.js";
import {
  getUltraPlanIdleReasonLabel,
  resolveUltraPlanCurrentCursor,
  resolveUltraPlanSessionBucket,
  type UltraPlanVisibleSession,
} from "../ultraplan/session-selection.js";
import { ULTRAPLAN_AUTHORED_JSON_FILENAME } from "../ultraplan/project-paths.js";
import {
  loadUltraPlanAuthoredArtifact,
  loadUltraPlanIndex,
  loadUltraPlanManifest,
  loadUltraPlanSessionSummary,
} from "../ultraplan/storage.js";
import { resolveSessionMigration } from "../ultraplan/runtime/migration.js";

const SUBCOMMANDS = [
  { name: "run", description: "Inspect an existing ultraplan session" },
  { name: "status", description: "Show status for an ultraplan session" },
  { name: "next", description: "Deferred to a later ultraplan phase" },
] as const;

type VisibleSessionLoadFailure = {
  sessionId: string;
  message: string;
};

type VisibleSessionsLoadResult =
  | { kind: "ok"; sessions: UltraPlanVisibleSession[]; failures: VisibleSessionLoadFailure[] }
  | { kind: "missing-index"; message: string }
  | { kind: "invalid-index"; message: string };

function parseUltraplanSubcommand(args?: string): string | null {
  const first = args?.trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : null;
}

function buildCursorManifest(summary: UltraPlanSessionSummary): UltraPlanManifest {
  return {
    sessionId: summary.sessionId,
    projectName: summary.projectName,
    title: summary.title,
    authored: {
      json: ULTRAPLAN_AUTHORED_JSON_FILENAME,
    },
    state: summary.state,
    cursor: summary.cursor,
    lastCompleted: summary.lastCompleted,
    progress: summary.progress,
    stacks: summary.stacks,
    blocker: summary.blocker,
    reviews: summary.reviews,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
}

function formatVisibleSessionFailure(
  sessionId: string,
  error: { message: string; details?: string[] },
): VisibleSessionLoadFailure {
  const detailLines = error.details?.length ? `\n${error.details.join("\n")}` : "";
  return {
    sessionId,
    message: `${sessionId}: ${error.message}${detailLines}`,
  };
}


function loadVisibleSessions(
  platform: Platform,
  cwd: string,
  options?: { includeDone?: boolean },
): VisibleSessionsLoadResult {
  const index = loadUltraPlanIndex(platform.paths, cwd);
  if (!index.ok) {
    return index.error.kind === "missing"
      ? { kind: "missing-index", message: index.error.message }
      : { kind: "invalid-index", message: index.error.message };
  }

  const includeDone = options?.includeDone ?? false;
  const sessions: UltraPlanVisibleSession[] = [];
  const failures: VisibleSessionLoadFailure[] = [];
  const nowIso = new Date().toISOString();

  for (const entry of index.value.sessions) {
    const migration = resolveSessionMigration({
      paths: platform.paths,
      cwd,
      sessionId: entry.sessionId,
      nowIso,
    });
    if (migration.kind === "blocked") {
      failures.push(formatVisibleSessionFailure(entry.sessionId, {
        message: migration.blocker.message,
        details: [
          `blocker: ${migration.blocker.code}`,
          `recovery: ${migration.blocker.recoveryMode}`,
          `next action: ${migration.blocker.nextAction}`,
        ],
      }));
      continue;
    }
    if (migration.kind === "skip") {
      continue;
    }

    const summary = loadUltraPlanSessionSummary(platform.paths, cwd, entry.sessionId);
    if (!summary.ok) {
      failures.push(formatVisibleSessionFailure(entry.sessionId, summary.error));
      continue;
    }

    const authored = loadUltraPlanAuthoredArtifact(platform.paths, cwd, entry.sessionId);
    if (!authored.ok) {
      failures.push(formatVisibleSessionFailure(entry.sessionId, authored.error));
      continue;
    }

    const resolved = resolveUltraPlanCurrentCursor(buildCursorManifest(summary.value), authored.value);
    const session: UltraPlanVisibleSession = {
      ...summary.value,
      cursor: resolved.cursor,
      bucket: resolveUltraPlanSessionBucket(summary.value, resolved),
      idleReasonLabel: getUltraPlanIdleReasonLabel(summary.value),
    };

    if (includeDone || session.bucket !== "done") {
      sessions.push(session);
    }
  }

  return { kind: "ok", sessions, failures };
}

async function selectSession(
  platform: Platform,
  ctx: any,
  options?: { includeDone?: boolean },
): Promise<UltraPlanVisibleSession | null> {
  const loaded = loadVisibleSessions(platform, ctx.cwd, options);
  if (loaded.kind === "missing-index") {
    notifyWarning(ctx, "Ultraplan session index is missing", "The resumable session index is unavailable. Rebuild the index or create a new ultraplan session.");
    return null;
  }

  if (loaded.kind === "invalid-index") {
    notifyError(ctx, "Ultraplan session index is invalid", loaded.message);
    return null;
  }

  if (loaded.failures.length > 0) {
    notifyWarning(
      ctx,
      "Skipped invalid ultraplan sessions",
      loaded.failures.map((failure) => failure.message).join("\n"),
    );
  }

  const sessions = loaded.sessions;
  if (sessions.length === 0) {
    notifyInfo(
      ctx,
      options?.includeDone ? "No ultraplan sessions" : "No incomplete ultraplan sessions",
      loaded.failures.length > 0
        ? "Fix the skipped session artifacts or create a new ultraplan session."
        : options?.includeDone
          ? "Create a new ultraplan session in a later phase."
          : "Run authoring in a later phase to create one.",
    );
    return null;
  }

  const optionsList = buildUltraPlanPickerOptions(sessions);
  const entries = optionsList.map((option, index) => {
    const display = `${option.label} — ${option.description}`;
    return [display, sessions[index]] as const;
  });
  const displayToSession = new Map(entries);
  const displayOptions = entries.map(([display]) => display);

  const selected = await ctx.ui.select("Ultraplan sessions", displayOptions, {
    helpText: "Pick a session · Esc to cancel",
  });
  if (!selected) {
    return null;
  }

  return displayToSession.get(selected) ?? null;
}

async function presentSelectedSession(platform: Platform, ctx: any, session: UltraPlanVisibleSession, mode: "run" | "status"): Promise<void> {
  const manifest = loadUltraPlanManifest(platform.paths, ctx.cwd, session.sessionId);
  if (!manifest.ok) {
    notifyError(ctx, "Ultraplan manifest is invalid", manifest.error.message);
    return;
  }

  const authored = loadUltraPlanAuthoredArtifact(platform.paths, ctx.cwd, session.sessionId);
  if (!authored.ok) {
    notifyError(ctx, "Ultraplan authored.json is invalid", authored.error.message);
    return;
  }

  const resolved = resolveUltraPlanCurrentCursor(manifest.value, authored.value);
  const statusText = renderUltraPlanStatus(session, authored.value, resolved);

  notifyInfo(
    ctx,
    mode === "run" ? "Ultraplan session" : "Ultraplan status",
    statusText,
  );
}

async function handleRun(platform: Platform, ctx: any): Promise<void> {
  if (!ctx.hasUI) {
    notifyWarning(ctx, "Ultraplan run requires interactive mode");
    return;
  }

  const session = await selectSession(platform, ctx);
  if (!session) {
    return;
  }

  await presentSelectedSession(platform, ctx, session, "run");
}

async function handleStatus(platform: Platform, ctx: any): Promise<void> {
  if (!ctx.hasUI) {
    notifyWarning(ctx, "Ultraplan status requires interactive mode");
    return;
  }

  const session = await selectSession(platform, ctx, { includeDone: true });
  if (!session) {
    return;
  }

  await presentSelectedSession(platform, ctx, session, "status");
}

export async function handleUltraplan(platform: Platform, ctx: any, args?: string): Promise<void> {
  const subcommand = parseUltraplanSubcommand(args);

  switch (subcommand) {
    case null:
      notifyInfo(ctx, "/supi:ultraplan authoring is not implemented in this phase");
      return;
    case "run":
      await handleRun(platform, ctx);
      return;
    case "status":
      await handleStatus(platform, ctx);
      return;
    case "next":
      notifyInfo(ctx, "/supi:ultraplan next is not implemented in this phase");
      return;
    default:
      notifyError(ctx, `Unknown subcommand "${subcommand}"`, `Available: ${SUBCOMMANDS.map((item) => item.name).join(", ")}`);
  }
}

export function registerUltraplanCommand(platform: Platform): void {
  platform.registerCommand("supi:ultraplan", {
    description: "Inspect or show status for ultraplan sessions",
    getArgumentCompletions(prefix: string) {
      const lower = prefix.toLowerCase();
      const matches = SUBCOMMANDS
        .filter((subcommand) => subcommand.name.startsWith(lower))
        .map((subcommand) => ({
          value: `${subcommand.name} `,
          label: subcommand.name,
          description: subcommand.description,
        }));
      return matches.length > 0 ? matches : null;
    },
    async handler(args: string | undefined, ctx: any) {
      await handleUltraplan(platform, ctx, args);
    },
  });
}


/**
 * Test-only entry point exposing the migration-integrated visible-session loader. Production
 * code uses the internal `loadVisibleSessions` helper; tests import this wrapper to avoid
 * reaching through the module boundary.
 */
export function loadVisibleSessionsForTesting(
  input: { platform: Platform; cwd: string; options?: { includeDone?: boolean } },
): VisibleSessionsLoadResult {
  return loadVisibleSessions(input.platform, input.cwd, input.options);
}