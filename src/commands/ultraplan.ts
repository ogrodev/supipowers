import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  UltraPlanBatchActiveRunLease,
  UltraPlanBatchNode,
  UltraPlanBatchRun,
  UltraPlanManifest,
  UltraPlanSessionSummary,
} from "../types.js";
import type { Platform } from "../platform/types.js";
import { notifyError, notifyInfo, notifyWarning } from "../notifications/renderer.js";
import {
  buildUltraPlanPickerOptions,
  renderUltraPlanRecommendationStatusLine,
  renderUltraPlanRecommendationSummary,
  renderUltraPlanRunOutcome,
  renderUltraPlanStatus,
} from "../ultraplan/presenter.js";
import {
  renderUltraPlanBatchNodeSummary,
  renderUltraPlanBatchSummary,
} from "../ultraplan/batch/presenter.js";
import {
  rankUltraPlanVisibleSessions,
  type UltraPlanSessionRecommendation,
} from "../ultraplan/next-router.js";
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
import {
  acquireUltraPlanBatchActiveRunLease,
  appendUltraPlanBatchJournalEvent,
  loadUltraPlanActiveBatchRun,
  loadUltraPlanBatchActiveRunLease,
  loadUltraPlanBatchRun,
  releaseUltraPlanBatchActiveRunLease,
  saveUltraPlanBatchRun,
} from "../ultraplan/batch/storage.js";
import { mergeUltraPlanBatchWorktree } from "../ultraplan/batch/merge.js";
import { runUltraPlanBatchWorker } from "../ultraplan/batch/worker.js";
import { prepareUltraPlanBatchWorktree } from "../ultraplan/batch/worktree.js";
import { computeUltraPlanBatchEligibleFrontier } from "../ultraplan/batch/planner.js";
import {
  abandonUltraPlanBatchNode,
  abandonUltraPlanBatchRun,
  resumeUltraPlanBatchSupervisor,
  runUltraPlanBatchSupervisor,
  type UltraPlanBatchSupervisorDeps,
} from "../ultraplan/batch/supervisor.js";
import { resolveSessionMigration } from "../ultraplan/runtime/migration.js";
import { runUltraPlanSession } from "../ultraplan/execution/session-runner.js";
import { detectBaseBranch } from "../git/base-branch.js";
import { resolveRepoIdentityRootFromFs, resolveRepoRoot } from "../workspace/repo-root.js";
import {
  driveAuthoringPipeline,
  handleBareEntry as handleAuthoringBareEntry,
  handlePlan,
  handleResume,
  handleStageSubcommand,
} from "../ultraplan/authoring/command-handlers.js";

const SUBCOMMANDS = [
  { name: "plan", description: "Start a new multi-stage authoring pipeline (default flow)" },
  { name: "discover", description: "Run/advance the discover stage of an authoring session" },
  { name: "research", description: "Run/advance the research stage of an authoring session" },
  { name: "synthesize", description: "Run/advance the synthesize stage of an authoring session" },
  { name: "review", description: "Run/advance the review stage of an authoring session" },
  { name: "approve", description: "Promote an approved draft to the canonical session" },
  { name: "resume", description: "Resume an in-flight authoring session" },
  { name: "quick", description: "Legacy single-shot authoring (deprecated; removed next release)" },
  { name: "run", description: "Run a session or start/resume a batch" },
  { name: "status", description: "Inspect status for an existing ultraplan session" },
  { name: "next", description: "Recommend the next ultraplan session to run" },
] as const;

type UltraPlanSubcommand = (typeof SUBCOMMANDS)[number]["name"];

const ULTRAPLAN_RECOMMENDATION_SURFACE_KEY = "supi-ultraplan-next";

type VisibleSessionLoadFailure = {
  sessionId: string;
  message: string;
};

type VisibleSessionsLoadResult =
  | { kind: "ok"; sessions: UltraPlanVisibleSession[]; failures: VisibleSessionLoadFailure[] }
  | { kind: "missing-index"; message: string }
  | { kind: "invalid-index"; message: string };

type SessionPickerSelection = {
  session: UltraPlanVisibleSession;
  recommendation: UltraPlanSessionRecommendation | null;
};

type SessionPickerState = {
  orderedSessions: UltraPlanVisibleSession[];
  recommendations: ReadonlyMap<string, UltraPlanSessionRecommendation>;
  topRecommendation: UltraPlanSessionRecommendation | null;
};

function parseUltraplanSubcommand(args?: string): UltraPlanSubcommand | null {
  const first = args?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  return SUBCOMMANDS.some((subcommand) => subcommand.name === first) ? (first as UltraPlanSubcommand) : null;
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

function buildRankedIncompleteSessions(sessions: UltraPlanVisibleSession[]): {
  sessions: UltraPlanVisibleSession[];
  recommendations: ReadonlyMap<string, UltraPlanSessionRecommendation>;
} {
  const ranked = rankUltraPlanVisibleSessions(sessions.filter((session) => session.bucket !== "done"));
  return {
    sessions: ranked.map((recommendation) => recommendation.session),
    recommendations: new Map(
      ranked.map((recommendation) => [recommendation.session.sessionId, recommendation] as const),
    ),
  };
}

function sortDoneSessions(sessions: UltraPlanVisibleSession[]): UltraPlanVisibleSession[] {
  return [...sessions].sort((left, right) =>
    left.title.localeCompare(right.title) || left.sessionId.localeCompare(right.sessionId));
}

function projectRecommendationStatus(
  ctx: any,
  recommendation: UltraPlanSessionRecommendation | null,
): void {
  const content = recommendation ? renderUltraPlanRecommendationStatusLine(recommendation) : undefined;
  try {
    ctx.ui?.setStatus?.(ULTRAPLAN_RECOMMENDATION_SURFACE_KEY, content);
  } catch {
    // Projection is advisory only; command behavior must continue unchanged.
  }
  try {
    ctx.ui?.setWidget?.(ULTRAPLAN_RECOMMENDATION_SURFACE_KEY, content);
  } catch {
    // Projection is advisory only; command behavior must continue unchanged.
  }
}

function loadSessionPickerState(
  platform: Platform,
  ctx: any,
  options?: { includeDone?: boolean },
): SessionPickerState | null {
  const loaded = loadVisibleSessions(platform, ctx.cwd, options);
  if (loaded.kind === "missing-index") {
    projectRecommendationStatus(ctx, null);
    notifyWarning(ctx, "Ultraplan session index is missing", "The resumable session index is unavailable. Rebuild the index or create a new ultraplan session.");
    return null;
  }

  if (loaded.kind === "invalid-index") {
    projectRecommendationStatus(ctx, null);
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

  const rankedIncomplete = buildRankedIncompleteSessions(loaded.sessions);
  const orderedSessions = options?.includeDone
    ? [
        ...rankedIncomplete.sessions,
        ...sortDoneSessions(loaded.sessions.filter((session) => session.bucket === "done")),
      ]
    : rankedIncomplete.sessions;
  const topRecommendation = rankedIncomplete.sessions.length > 0
    ? rankedIncomplete.recommendations.get(rankedIncomplete.sessions[0].sessionId) ?? null
    : null;
  projectRecommendationStatus(ctx, topRecommendation);
  if (orderedSessions.length === 0) {
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

  return {
    orderedSessions,
    recommendations: rankedIncomplete.recommendations,
    topRecommendation,
  };
}

async function selectSession(
  platform: Platform,
  ctx: any,
  options?: { includeDone?: boolean },
): Promise<SessionPickerSelection | null> {
  const state = loadSessionPickerState(platform, ctx, options);
  if (!state) {
    return null;
  }

  const optionsList = buildUltraPlanPickerOptions(state.orderedSessions, state.recommendations);
  const entries = optionsList.map((option, index) => {
    const session = state.orderedSessions[index];
    const display = `${option.label} — ${option.description}`;
    return [display, { session, recommendation: state.recommendations.get(session.sessionId) ?? null }] as const;
  });
  const displayToSelection = new Map(entries);
  const displayOptions = entries.map(([display]) => display);

  const selected = await ctx.ui.select("Ultraplan sessions", displayOptions, {
    helpText: "Pick a session · Esc to cancel",
  });
  if (!selected) {
    return null;
  }

  return displayToSelection.get(selected) ?? null;
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

async function runSelectedSession(platform: Platform, ctx: any, session: UltraPlanVisibleSession): Promise<void> {
  const outcome = await runUltraPlanSession({
    platform,
    cwd: ctx.cwd,
    sessionId: session.sessionId,
  });

  notifyInfo(
    ctx,
    outcome.kind === "completed" ? "Ultraplan complete" : "Ultraplan paused",
    renderUltraPlanRunOutcome(outcome),
  );
}

type UltraPlanRunBatchState =
  | { kind: "single-or-batch" }
  | { kind: "resume-batch"; run: UltraPlanBatchRun; lease: UltraPlanBatchActiveRunLease }
  | { kind: "invalid-run"; message: string };

const BATCH_LEASE_DURATION_MS = 5 * 60 * 1000;
const BATCH_LEASE_RENEWAL_INTERVAL_MS = Math.max(1_000, Math.floor(BATCH_LEASE_DURATION_MS / 3));
const BATCH_GIT_TIMEOUT_MS = 120_000;

function resolveUltraPlanRunBatchState(
  input: { paths: Platform["paths"]; cwd: string },
): UltraPlanRunBatchState {
  const lease = loadUltraPlanBatchActiveRunLease(input.paths, input.cwd);
  if (!lease.ok) {
    return { kind: "invalid-run", message: `invalid-run: ${lease.error.message}` };
  }
  if (lease.value === null) {
    return { kind: "single-or-batch" };
  }

  const run = loadUltraPlanActiveBatchRun(input.paths, input.cwd);
  if (!run.ok || run.value === null) {
    return {
      kind: "invalid-run",
      message: `invalid-run: ${run.ok ? "active batch run is missing" : run.error.message}` ,
    };
  }
  if (run.value.state === "complete" || run.value.state === "abandoned") {
    return {
      kind: "invalid-run",
      message: `invalid-run: active-run.json points at terminal batch ${run.value.runId}` ,
    };
  }

  return { kind: "resume-batch", run: run.value, lease: lease.value };
}

function deriveBatchWaves(nodes: UltraPlanBatchNode[]): UltraPlanBatchRun["waves"] {
  return [...new Set(nodes.map((node) => node.waveIndex))]
    .sort((left, right) => left - right)
    .map((waveIndex) => ({
      waveIndex,
      sessionIds: nodes.filter((node) => node.waveIndex === waveIndex).map((node) => node.sessionId),
    }));
}

function cloneBatchRun(run: UltraPlanBatchRun): UltraPlanBatchRun {
  return {
    ...run,
    nodes: run.nodes.map((node) => ({ ...node })),
    waves: run.waves.map((wave) => ({ ...wave, sessionIds: [...wave.sessionIds] })),
  };
}

function buildBatchRun(
  input: { paths: Platform["paths"]; cwd: string; sessionIds: string[]; maxParallelism: number },
): UltraPlanBatchRun {
  const nowIso = new Date().toISOString();
  const runId = `batch-${Math.random().toString(36).slice(2, 10)}`;
  const nodes = input.sessionIds.map((sessionId, index) => ({
    nodeId: `node-${index + 1}` ,
    sessionId,
    title: sessionId,
    waveIndex: 0,
    dependencies: [],
    state: "pending" as const,
    blockerKind: null,
    blockerSummary: null,
    resumeRequestedAt: null,
    branchName: null,
    worktreePath: null,
    updatedAt: nowIso,
  }));
  return {
    runId,
    projectRoot: input.cwd,
    baseBranch: "main",
    baseHead: "sha-base",
    currentBaseHead: "sha-base",
    createdAt: nowIso,
    updatedAt: nowIso,
    state: "paused",
    maxParallelism: input.maxParallelism,
    batchBlockerCode: null,
    batchBlockerSummary: null,
    batchResumeRequestedAt: null,
    supervisorWorktreePath: input.cwd,
    waves: deriveBatchWaves(nodes),
    nodes,
  };
}

function persistPlannedBatchRun(
  input: { paths: Platform["paths"]; cwd: string; run: UltraPlanBatchRun },
): UltraPlanBatchRun {
  saveBatchRunOrThrow(input.paths, input.cwd, input.run);
  return input.run;
}

async function buildLiveBatchRun(
  input: { platform: Platform; cwd: string; sessionIds: string[]; maxParallelism: number },
): Promise<UltraPlanBatchRun> {
  const repoRoot = await resolveRepoRoot(input.platform, input.cwd);
  const baseBranch = await detectBaseBranch((cmd, args) => input.platform.exec(cmd, args, { cwd: repoRoot }));
  const baseHead = await readGitHead(input.platform, repoRoot);
  const nowIso = new Date().toISOString();
  const runId = `batch-${Math.random().toString(36).slice(2, 10)}`;
  const nodes = input.sessionIds.map((sessionId, index) => {
    const summary = loadUltraPlanSessionSummary(input.platform.paths, input.cwd, sessionId);
    if (!summary.ok) {
      throw new Error(summary.error.message);
    }
    return {
      nodeId: `node-${index + 1}` ,
      sessionId,
      title: summary.value.title,
      waveIndex: 0,
      dependencies: [],
      state: "pending" as const,
      blockerKind: null,
      blockerSummary: null,
      resumeRequestedAt: null,
      branchName: null,
      worktreePath: null,
      updatedAt: nowIso,
    };
  });

  return {
    runId,
    projectRoot: repoRoot,
    baseBranch,
    baseHead,
    currentBaseHead: baseHead,
    createdAt: nowIso,
    updatedAt: nowIso,
    state: "paused",
    maxParallelism: input.maxParallelism,
    batchBlockerCode: null,
    batchBlockerSummary: null,
    batchResumeRequestedAt: null,
    supervisorWorktreePath: repoRoot,
    waves: deriveBatchWaves(nodes),
    nodes,
  };
}

async function readGitHead(platform: Platform, cwd: string): Promise<string> {
  const result = await platform.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: BATCH_GIT_TIMEOUT_MS });
  const head = firstNonEmpty(result.stdout);
  if (result.code !== 0 || !head) {
    throw new Error(firstNonEmpty(result.stderr, result.stdout) ?? `Unable to resolve git HEAD for ${cwd}`);
  }
  return head;
}

function saveBatchRunOrThrow(paths: Platform["paths"], cwd: string, run: UltraPlanBatchRun): void {
  run.waves = deriveBatchWaves(run.nodes);
  const saved = saveUltraPlanBatchRun(paths, cwd, run);
  if (!saved.ok) {
    throw new Error(saved.error.message);
  }
}


function appendBatchJournalEventOrThrow(
  paths: Platform["paths"],
  cwd: string,
  runId: string,
  event: Parameters<typeof appendUltraPlanBatchJournalEvent>[3],
): void {
  const appended = appendUltraPlanBatchJournalEvent(paths, cwd, runId, event);
  if (!appended.ok) {
    throw new Error(appended.error.message);
  }
}

function makeBatchLease(runId: string, ownerSessionId: string, nowIso: string): UltraPlanBatchActiveRunLease {
  return {
    runId,
    ownerSessionId,
    leaseAcquiredAt: nowIso,
    leaseExpiresAt: new Date(Date.parse(nowIso) + BATCH_LEASE_DURATION_MS).toISOString(),
    updatedAt: nowIso,
  };
}

type BatchLeaseRenewalController = {
  stop(): void;
  assertHealthy(): void;
  runWithRenewal<T>(work: Promise<T>): Promise<T>;
};

function acquireBatchLeaseOrThrow(
  input: { paths: Platform["paths"]; cwd: string; runId: string; ownerSessionId: string; nowIso: string },
): UltraPlanBatchActiveRunLease {
  const lease = makeBatchLease(input.runId, input.ownerSessionId, input.nowIso);
  const acquired = acquireUltraPlanBatchActiveRunLease(input.paths, input.cwd, lease, { nowIso: input.nowIso });
  if (!acquired.ok) {
    throw new Error(acquired.error.message);
  }
  return acquired.value;
}

function startBatchLeaseRenewal(
  input: { paths: Platform["paths"]; cwd: string; runId: string; ownerSessionId: string },
): BatchLeaseRenewalController {
  let renewalError: Error | null = null;
  let rejectFailure: ((error: Error) => void) | null = null;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  failure.catch(() => undefined);

  function renew(): void {
    acquireBatchLeaseOrThrow({
      ...input,
      nowIso: new Date().toISOString(),
    });
  }

  const timer = setInterval(() => {
    try {
      renew();
    } catch (error) {
      renewalError = error instanceof Error ? error : new Error("UltraPlan batch lease renewal failed.");
      clearInterval(timer);
      rejectFailure?.(renewalError);
    }
  }, BATCH_LEASE_RENEWAL_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
    assertHealthy() {
      if (renewalError) {
        throw renewalError;
      }
    },
    async runWithRenewal<T>(work: Promise<T>): Promise<T> {
      const result = await Promise.race([work, failure]);
      this.assertHealthy();
      return result;
    },
  };
}

function makeBatchOwnerSessionId(): string {
  return `ultraplan-batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isLiveBatchLease(lease: UltraPlanBatchActiveRunLease, nowIso: string): boolean {
  if (!lease.ownerSessionId || !lease.leaseAcquiredAt || !lease.leaseExpiresAt) {
    return false;
  }
  const expiresAt = Date.parse(lease.leaseExpiresAt);
  const now = Date.parse(nowIso);
  return Number.isFinite(expiresAt) && Number.isFinite(now) && expiresAt > now;
}

function mapBatchNodeStateToJournalType(
  state: UltraPlanBatchNode["state"],
): Parameters<typeof appendUltraPlanBatchJournalEvent>[3]["type"] | null {
  switch (state) {
    case "preparing":
      return "node-preparing";
    case "running":
      return "node-running";
    case "paused":
      return "node-paused";
    case "blocked":
      return "node-blocked";
    case "awaiting-user":
      return "node-awaiting-user";
    case "merge-pending":
      return "node-merge-pending";
    case "merged":
      return "node-merged";
    case "abandoned":
      return "node-abandoned";
    default:
      return null;
  }
}

function appendBatchNodeTransitionEvents(
  paths: Platform["paths"],
  cwd: string,
  previous: UltraPlanBatchRun,
  next: UltraPlanBatchRun,
): void {
  const previousNodes = new Map(previous.nodes.map((node) => [node.sessionId, node] as const));
  for (const node of next.nodes) {
    const previousNode = previousNodes.get(node.sessionId);
    const eventType = mapBatchNodeStateToJournalType(node.state);
    if (eventType && previousNode?.state !== node.state) {
      appendBatchJournalEventOrThrow(paths, cwd, next.runId, {
        runId: next.runId,
        sessionId: node.sessionId,
        type: eventType,
        recordedAt: next.updatedAt,
        summary: renderUltraPlanBatchNodeSummary(node, next),
      });
    }
    if (node.state === "merged" && node.worktreePath !== null && previousNode?.worktreePath !== node.worktreePath) {
      appendBatchJournalEventOrThrow(paths, cwd, next.runId, {
        runId: next.runId,
        sessionId: node.sessionId,
        type: "cleanup-warning",
        recordedAt: next.updatedAt,
        summary: `Merged ${node.sessionId} but kept worktree ${node.worktreePath} for manual cleanup.`,
      });
    }
  }
}

async function ensureBatchNodeWorktree(
  platform: Platform,
  run: UltraPlanBatchRun,
  node: UltraPlanBatchNode,
): Promise<{ kind: "ready"; branchName: string; worktreePath: string } | { kind: "blocked"; summary: string }> {
  const preparation = prepareUltraPlanBatchWorktree({
    repoRoot: run.projectRoot,
    runId: run.runId,
    sessionId: node.sessionId,
    globalWorktreesRoot: platform.paths.global("worktrees"),
    deps: { readBranchName: readGitBranchNameSync },
  });
  if (preparation.kind === "blocked") {
    return { kind: "blocked", summary: preparation.summary };
  }
  if (preparation.kind === "reused") {
    return { kind: "ready", branchName: preparation.branchName, worktreePath: preparation.worktreePath };
  }

  const branchExists = await gitBranchExists(platform, run.projectRoot, preparation.branchName);
  const args = branchExists
    ? ["worktree", "add", preparation.worktreePath, preparation.branchName]
    : ["worktree", "add", "-b", preparation.branchName, preparation.worktreePath, run.currentBaseHead];
  const created = await platform.exec("git", args, { cwd: run.projectRoot, timeout: BATCH_GIT_TIMEOUT_MS });
  if (created.code !== 0) {
    return {
      kind: "blocked",
      summary: firstNonEmpty(created.stderr, created.stdout) ?? `Unable to create worktree ${preparation.worktreePath}.`,
    };
  }

  return { kind: "ready", branchName: preparation.branchName, worktreePath: preparation.worktreePath };
}

async function gitBranchExists(platform: Platform, cwd: string, branchName: string): Promise<boolean> {
  const result = await platform.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
    cwd,
    timeout: BATCH_GIT_TIMEOUT_MS,
  });
  return result.code === 0;
}

function readGitBranchNameSync(worktreePath: string): string | null {
  const result = runGitSync(worktreePath, ["branch", "--show-current"]);
  return result.code === 0 ? firstNonEmpty(result.stdout) : null;
}

function inspectSupervisorWorktreeSync(supervisorWorktreePath: string) {
  const branchResult = runGitSync(supervisorWorktreePath, ["branch", "--show-current"]);
  const headResult = runGitSync(supervisorWorktreePath, ["rev-parse", "HEAD"]);
  const dirtyResult = runGitSync(supervisorWorktreePath, ["status", "--porcelain", "--untracked-files=no"]);
  const gitDirResult = runGitSync(supervisorWorktreePath, ["rev-parse", "--git-dir"]);
  const gitDir = gitDirResult.code === 0 && firstNonEmpty(gitDirResult.stdout)
    ? path.resolve(supervisorWorktreePath, firstNonEmpty(gitDirResult.stdout)!)
    : null;
  const inProgressOperation = gitDir !== null && [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "rebase-merge",
    "rebase-apply",
  ].some((candidate) => fs.existsSync(path.join(gitDir, candidate)));
  return {
    headAttached: branchResult.code === 0 && firstNonEmpty(branchResult.stdout) !== "HEAD",
    branchName: branchResult.code === 0 ? firstNonEmpty(branchResult.stdout) : null,
    dirtyTracked: dirtyResult.code === 0 && firstNonEmpty(dirtyResult.stdout) !== null,
    inProgressOperation,
    headSha: firstNonEmpty(headResult.stdout) ?? "unknown",
  };
}

function mergeBranchSync(
  supervisorWorktreePath: string,
  branchName: string,
): { ok: true; newBaseHead: string } | { ok: false; summary: string } {
  const merge = runGitSync(supervisorWorktreePath, ["merge", "--no-edit", branchName]);
  if (merge.code !== 0) {
    const abort = runGitSync(supervisorWorktreePath, ["merge", "--abort"]);
    const summary = abort.code === 0
      ? firstNonEmpty(merge.stderr, merge.stdout)
      : firstNonEmpty(
          merge.stderr,
          merge.stdout,
          abort.stderr,
          abort.stdout,
          `Merge failed for ${branchName} and merge --abort did not cleanly recover the supervisor worktree.`,
        );
    return { ok: false, summary: summary ?? `Merge failed for ${branchName}.` };
  }
  const head = runGitSync(supervisorWorktreePath, ["rev-parse", "HEAD"]);
  const newBaseHead = firstNonEmpty(head.stdout);
  if (head.code !== 0 || !newBaseHead) {
    return { ok: false, summary: "Merged branch but could not resolve the updated supervisor HEAD." };
  }
  return { ok: true, newBaseHead };
}

function cleanupWorktreeSync(
  repoRoot: string,
  worktreePath: string,
): { ok: true } | { ok: false; summary: string } {
  const cleanup = runGitSync(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  if (cleanup.code !== 0) {
    return { ok: false, summary: firstNonEmpty(cleanup.stderr, cleanup.stdout) ?? `Unable to remove ${worktreePath}.` };
  }
  return { ok: true };
}

function runGitSync(cwd: string, args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  };
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

function buildLiveBatchSupervisorDeps(platform: Platform): UltraPlanBatchSupervisorDeps {
  return {
    computeFrontier: computeUltraPlanBatchEligibleFrontier,
    async runWorker(node, run) {
      const prepared = await ensureBatchNodeWorktree(platform, run, node);
      node.updatedAt = new Date().toISOString();
      if (prepared.kind === "blocked") {
        return { kind: "blocked", blockerKind: "supervisor", summary: prepared.summary };
      }
      node.branchName = prepared.branchName;
      node.worktreePath = prepared.worktreePath;
      try {
        return await runUltraPlanBatchWorker({
          platform,
          sessionId: node.sessionId,
          worktreeCwd: prepared.worktreePath,
        });
      } catch (error) {
        return {
          kind: "blocked",
          blockerKind: "supervisor",
          summary: error instanceof Error
            ? `Worker ${node.sessionId} failed after worktree preparation: ${error.message}`
            : `Worker ${node.sessionId} failed after worktree preparation.`,
        };
      }
    },
    async mergeNode(node, run) {
      if (!node.branchName || !node.worktreePath) {
        return {
          kind: "blocked",
          code: "supervisor-worktree-invalid",
          currentBaseHead: run.currentBaseHead,
          worktreePath: node.worktreePath ?? run.supervisorWorktreePath ?? run.projectRoot,
          summary: `Cannot merge ${node.sessionId} without a prepared branch and worktree.`,
          countsAgainstParallelism: false,
        };
      }
      try {
        if (!run.supervisorWorktreePath) {
          return {
            kind: "blocked",
            code: "supervisor-worktree-invalid",
            currentBaseHead: run.currentBaseHead,
            worktreePath: node.worktreePath,
            summary: "Supervisor worktree path is missing.",
            countsAgainstParallelism: false,
          };
        }
        if (resolveRepoIdentityRootFromFs(run.supervisorWorktreePath) !== resolveRepoIdentityRootFromFs(run.projectRoot)) {
          return {
            kind: "blocked",
            code: "project-identity-failed",
            currentBaseHead: run.currentBaseHead,
            worktreePath: node.worktreePath,
            summary: "Supervisor worktree no longer resolves to the same repository identity as the batch run.",
            countsAgainstParallelism: false,
          };
        }
      } catch (error) {
        return {
          kind: "blocked",
          code: "project-identity-failed",
          currentBaseHead: run.currentBaseHead,
          worktreePath: node.worktreePath,
          summary: error instanceof Error ? error.message : "Unable to resolve supervisor worktree identity.",
          countsAgainstParallelism: false,
        };
      }
      return mergeUltraPlanBatchWorktree({
        supervisorBranch: run.baseBranch,
        currentBaseHead: run.currentBaseHead,
        branchName: node.branchName,
        worktreePath: node.worktreePath,
        deps: {
          inspectSupervisorWorktree: () => inspectSupervisorWorktreeSync(run.supervisorWorktreePath ?? run.projectRoot),
          mergeBranch: (branchName) => mergeBranchSync(run.supervisorWorktreePath ?? run.projectRoot, branchName),
          cleanupWorktree: (worktreePath) => cleanupWorktreeSync(run.projectRoot, worktreePath),
        },
      });
    },
  };
}

function snapshotBatchRun(run: UltraPlanBatchRun): string {
  return JSON.stringify({
    state: run.state,
    batchBlockerCode: run.batchBlockerCode,
    batchBlockerSummary: run.batchBlockerSummary,
    batchResumeRequestedAt: run.batchResumeRequestedAt,
    currentBaseHead: run.currentBaseHead,
    nodes: run.nodes.map((node) => ({
      sessionId: node.sessionId,
      state: node.state,
      blockerKind: node.blockerKind,
      blockerSummary: node.blockerSummary,
      resumeRequestedAt: node.resumeRequestedAt,
      branchName: node.branchName,
      worktreePath: node.worktreePath,
    })),
  });
}

function withBatchUpdatedAt(run: UltraPlanBatchRun, nowIso: string): UltraPlanBatchRun {
  return {
    ...run,
    updatedAt: nowIso,
    nodes: run.nodes.map((node) => ({ ...node, updatedAt: nowIso })),
    waves: deriveBatchWaves(run.nodes),
  };
}

async function executeLiveBatchRun(
  input: { platform: Platform; cwd: string; run: UltraPlanBatchRun; mode: "start" | "resume" },
): Promise<UltraPlanBatchRun> {
  const ownerSessionId = makeBatchOwnerSessionId();
  let current = cloneBatchRun(input.run);
  let leaseHeld = false;
  let leaseRenewal: BatchLeaseRenewalController | null = null;
  try {
    if (input.mode === "start") {
      persistPlannedBatchRun({ paths: input.platform.paths, cwd: input.cwd, run: current });
      appendBatchJournalEventOrThrow(input.platform.paths, input.cwd, current.runId, {
        runId: current.runId,
        sessionId: null,
        type: "run-created",
        recordedAt: current.createdAt,
        summary: `Created batch run ${current.runId}.`,
        details: { sessionIds: current.nodes.map((node) => node.sessionId), maxParallelism: current.maxParallelism },
      });
    } else {
      saveBatchRunOrThrow(input.platform.paths, input.cwd, current);
    }

    const acquiredAt = new Date().toISOString();
    acquireBatchLeaseOrThrow({
      paths: input.platform.paths,
      cwd: input.cwd,
      runId: current.runId,
      ownerSessionId,
      nowIso: acquiredAt,
    });
    leaseHeld = true;
    appendBatchJournalEventOrThrow(input.platform.paths, input.cwd, current.runId, {
      runId: current.runId,
      sessionId: null,
      type: "lease-acquired",
      recordedAt: acquiredAt,
      summary: `Supervisor lease acquired by ${ownerSessionId}.`,
    });
    const leaseRenewalController = startBatchLeaseRenewal({
      paths: input.platform.paths,
      cwd: input.cwd,
      runId: current.runId,
      ownerSessionId,
    });
    leaseRenewal = leaseRenewalController;

    current = withBatchUpdatedAt({ ...current, state: "running" }, acquiredAt);
    saveBatchRunOrThrow(input.platform.paths, input.cwd, current);

    const deps = buildLiveBatchSupervisorDeps(input.platform);
    let firstPass = true;
    for (let pass = 0; pass < 100; pass++) {
      const previous = cloneBatchRun(current);
      const previousSnapshot = snapshotBatchRun(previous);
      const supervisorPass = firstPass && input.mode === "resume"
        ? resumeUltraPlanBatchSupervisor({ run: current, deps })
        : runUltraPlanBatchSupervisor({ run: current, deps });
      const next = await leaseRenewalController.runWithRenewal(supervisorPass);
      current = withBatchUpdatedAt(next, new Date().toISOString());
      saveBatchRunOrThrow(input.platform.paths, input.cwd, current);
      appendBatchNodeTransitionEvents(input.platform.paths, input.cwd, previous, current);
      firstPass = false;
      if (current.state !== "running") {
        break;
      }
      if (snapshotBatchRun(current) === previousSnapshot) {
        current = withBatchUpdatedAt({
          ...current,
          state: "blocked",
          batchBlockerCode: "invalid-run",
          batchBlockerSummary: "Batch supervisor made no observable progress while the run was still marked running.",
        }, new Date().toISOString());
        saveBatchRunOrThrow(input.platform.paths, input.cwd, current);
        break;
      }
    }

    if (leaseHeld) {
      const releasedAt = new Date().toISOString();
      const released = releaseUltraPlanBatchActiveRunLease(
        input.platform.paths,
        input.cwd,
        { runId: current.runId, ownerSessionId },
        current.state,
        releasedAt,
      );
      if (!released.ok) {
        throw new Error(released.error.message);
      }
      appendBatchJournalEventOrThrow(input.platform.paths, input.cwd, current.runId, {
        runId: current.runId,
        sessionId: null,
        type: "lease-released",
        recordedAt: releasedAt,
        summary: `Supervisor lease released after batch entered ${current.state}.`,
      });
      leaseHeld = false;
    }
    return current;
  } catch (error) {
    current = withBatchUpdatedAt({
      ...current,
      state: "blocked",
      batchBlockerCode: "invalid-run",
      batchBlockerSummary: error instanceof Error ? error.message : "UltraPlan batch supervision failed.",
    }, new Date().toISOString());
    saveBatchRunOrThrow(input.platform.paths, input.cwd, current);
    if (leaseHeld) {
      const releasedAt = new Date().toISOString();
      const released = releaseUltraPlanBatchActiveRunLease(
        input.platform.paths,
        input.cwd,
        { runId: current.runId, ownerSessionId },
        current.state,
        releasedAt,
      );
      if (released.ok) {
        appendBatchJournalEventOrThrow(input.platform.paths, input.cwd, current.runId, {
          runId: current.runId,
          sessionId: null,
          type: "lease-released",
          recordedAt: releasedAt,
          summary: `Supervisor lease released after batch entered ${current.state}.`,
        });
      }
    }
    return current;
  } finally {
    leaseRenewal?.stop();
  }
}

function renderBatchOutcomeTitle(run: UltraPlanBatchRun): string {
  if (run.state === "complete") {
    return "Ultraplan batch complete";
  }
  if (run.state === "blocked") {
    return "Ultraplan batch blocked";
  }
  return "Ultraplan batch paused";
}

function stampBatchResumeApproval(run: UltraPlanBatchRun, nowIso: string): UltraPlanBatchRun {
  return {
    ...cloneBatchRun(run),
    batchResumeRequestedAt: nowIso,
    updatedAt: nowIso,
    nodes: run.nodes.map((node) => ({ ...node, updatedAt: nowIso })),
  };
}

async function handleResumeBatch(
  platform: Platform,
  ctx: any,
  batchState: Extract<UltraPlanRunBatchState, { kind: "resume-batch" }>,
): Promise<void> {
  const nowIso = new Date().toISOString();
  if (isLiveBatchLease(batchState.lease, nowIso)) {
    notifyError(
      ctx,
      "invalid-run",
      `invalid-run: batch ${batchState.run.runId} is already supervised by ${batchState.lease.ownerSessionId}` ,
    );
    return;
  }

  let run = cloneBatchRun(batchState.run);
  if (run.state === "blocked" && run.batchBlockerCode) {
    const action = await ctx.ui.select(renderUltraPlanBatchSummary(run), ["Retry blocked batch", "Inspect batch", "Cancel"]);
    if (!action || action === "Cancel") {
      return;
    }
    if (action === "Inspect batch") {
      notifyInfo(ctx, "Ultraplan batch", renderUltraPlanBatchSummary(run));
      return;
    }
    run = stampBatchResumeApproval(run, nowIso);
    saveBatchRunOrThrow(platform.paths, ctx.cwd, run);
  }

  const finalRun = await executeLiveBatchRun({ platform, cwd: ctx.cwd, run, mode: "resume" });
  notifyInfo(ctx, renderBatchOutcomeTitle(finalRun), renderUltraPlanBatchSummary(finalRun));
}

export function resolveUltraPlanRunBatchStateForTesting(
  input: { paths: Platform["paths"]; cwd: string },
): UltraPlanRunBatchState {
  return resolveUltraPlanRunBatchState(input);
}

export function planUltraPlanBatchRunForTesting(
  input: { paths: Platform["paths"]; cwd: string; sessionIds: string[]; maxParallelism: number },
): UltraPlanBatchRun {
  return persistPlannedBatchRun({
    paths: input.paths,
    cwd: input.cwd,
    run: buildBatchRun(input),
  });
}

export function renderUltraPlanBatchStatusForTesting(
  input: { paths: Platform["paths"]; cwd: string },
): string {
  const batchState = resolveUltraPlanRunBatchState(input);
  switch (batchState.kind) {
    case "invalid-run":
      return batchState.message;
    case "resume-batch":
      return renderUltraPlanBatchSummary(batchState.run);
    default:
      return "No active batch";
  }
}

export function resumeUltraPlanBatchRunForTesting(
  input: {
    paths: Platform["paths"];
    cwd: string;
    batchResumeRequestedAt?: string;
    retrySessionId?: string;
    resumeRequestedAt?: string;
  },
): UltraPlanBatchRun {
  const batchState = resolveUltraPlanRunBatchState({ paths: input.paths, cwd: input.cwd });
  if (batchState.kind !== "resume-batch") {
    throw new Error(batchState.kind === "invalid-run" ? batchState.message : "No active batch to resume");
  }

  const updatedAt = input.resumeRequestedAt ?? input.batchResumeRequestedAt ?? batchState.run.updatedAt;
  const next: UltraPlanBatchRun = {
    ...batchState.run,
    batchResumeRequestedAt: input.batchResumeRequestedAt ?? batchState.run.batchResumeRequestedAt,
    updatedAt,
    nodes: batchState.run.nodes.map((node) =>
      node.sessionId === input.retrySessionId
        ? { ...node, resumeRequestedAt: input.resumeRequestedAt ?? node.resumeRequestedAt, updatedAt }
        : { ...node },
    ),
    waves: batchState.run.waves.map((wave) => ({ ...wave, sessionIds: [...wave.sessionIds] })),
  };

  saveBatchRunOrThrow(input.paths, input.cwd, next);
  return next;
}

export function abandonUltraPlanBatchForTesting(
  input: { paths: Platform["paths"]; cwd: string; runId: string },
): UltraPlanBatchRun {
  const run = loadUltraPlanBatchRun(input.paths, input.cwd, input.runId);
  if (!run.ok) {
    throw new Error(run.error.message);
  }
  const next = abandonUltraPlanBatchRun(run.value);
  saveBatchRunOrThrow(input.paths, input.cwd, next);
  return next;
}

export function abandonUltraPlanBatchNodeForTesting(
  input: { paths: Platform["paths"]; cwd: string; runId: string; sessionId: string },
): UltraPlanBatchRun {
  const run = loadUltraPlanBatchRun(input.paths, input.cwd, input.runId);
  if (!run.ok) {
    throw new Error(run.error.message);
  }
  const next = abandonUltraPlanBatchNode(run.value, input.sessionId);
  saveBatchRunOrThrow(input.paths, input.cwd, next);
  return next;
}

async function handleBatchPlanning(platform: Platform, ctx: any): Promise<void> {
  const sessionIdsInput = await ctx.ui.input("Batch session ids");
  if (!sessionIdsInput) {
    return;
  }
  const sessionIds = sessionIdsInput
    .split(",")
    .map((value: string) => value.trim())
    .filter((value: string) => value.length > 0);
  if (sessionIds.length === 0) {
    notifyError(ctx, "invalid-run", "invalid-run: batch planning requires at least one session id");
    return;
  }

  const maxParallelismInput = await ctx.ui.input("Max parallelism");
  const maxParallelism = Number.parseInt(maxParallelismInput ?? "", 10);
  if (!Number.isFinite(maxParallelism) || maxParallelism <= 0) {
    notifyError(ctx, "invalid-run", "invalid-run: maxParallelism must be a positive integer");
    return;
  }

  const confirmation = await ctx.ui.select("Batch plan", ["Start batch", "Cancel"]);
  if (confirmation !== "Start batch") {
    return;
  }

  try {
    const run = await buildLiveBatchRun({
      platform,
      cwd: ctx.cwd,
      sessionIds,
      maxParallelism,
    });
    const finalRun = await executeLiveBatchRun({ platform, cwd: ctx.cwd, run, mode: "start" });
    notifyInfo(ctx, renderBatchOutcomeTitle(finalRun), renderUltraPlanBatchSummary(finalRun));
  } catch (error) {
    notifyError(
      ctx,
      "invalid-run",
      `invalid-run: ${error instanceof Error ? error.message : "Unable to start UltraPlan batch."}` ,
    );
  }
}

async function handleRun(platform: Platform, ctx: any, args?: string): Promise<void> {
  if (!ctx.hasUI) {
    notifyWarning(ctx, "Ultraplan run requires interactive mode");
    return;
  }

  const batchState = resolveUltraPlanRunBatchState({ paths: platform.paths, cwd: ctx.cwd });
  if (batchState.kind === "invalid-run") {
    notifyError(ctx, "invalid-run", batchState.message);
    return;
  }
  if (batchState.kind === "resume-batch") {
    await handleResumeBatch(platform, ctx, batchState);
    return;
  }

  const wantsBatchPlanning = args?.trim().split(/\s+/).slice(1).includes("batch") ?? false;
  if (!wantsBatchPlanning) {
    const visible = loadVisibleSessions(platform, ctx.cwd);
    if (visible.kind === "ok" && visible.sessions.length > 1) {
      const mode = await ctx.ui.select("Ultraplan run mode", ["Single session", "Batch sessions", "Cancel"]);
      if (!mode || mode === "Cancel") {
        return;
      }
      if (mode === "Batch sessions") {
        await handleBatchPlanning(platform, ctx);
        return;
      }
    }
  }
  if (wantsBatchPlanning) {
    await handleBatchPlanning(platform, ctx);
    return;
  }

  const selected = await selectSession(platform, ctx);
  if (!selected) {
    return;
  }
  if (selected.recommendation?.action === "inspect") {
    await presentSelectedSession(platform, ctx, selected.session, "status");
    return;
  }

  await runSelectedSession(platform, ctx, selected.session);
}

async function handleStatus(platform: Platform, ctx: any): Promise<void> {
  if (!ctx.hasUI) {
    notifyWarning(ctx, "Ultraplan status requires interactive mode");
    return;
  }

  const selected = await selectSession(platform, ctx, { includeDone: true });
  if (!selected) {
    return;
  }

  await presentSelectedSession(platform, ctx, selected.session, "status");
}

async function handleNextSelection(
  platform: Platform,
  ctx: any,
  selection: SessionPickerSelection,
  options?: { allowChooseAnother?: boolean },
): Promise<void> {
  if (!selection.recommendation) {
    await presentSelectedSession(platform, ctx, selection.session, "status");
    return;
  }

  const choices = [
    ...(selection.recommendation.action === "run" ? ["Run this session", "Inspect session"] : ["Inspect session"]),
    ...(options?.allowChooseAnother === false ? [] : ["Choose another session"]),
    "Cancel",
  ];
  const choice = await ctx.ui.select(
    renderUltraPlanRecommendationSummary(selection.recommendation),
    choices,
    { helpText: "Pick an action · Esc to cancel" },
  );
  if (!choice || choice === "Cancel") {
    return;
  }
  if (choice === "Choose another session") {
    if (options?.allowChooseAnother === false) {
      return;
    }
    const alternative = await selectSession(platform, ctx);
    if (!alternative) {
      return;
    }
    if (alternative.recommendation?.action === "inspect") {
      await presentSelectedSession(platform, ctx, alternative.session, "status");
      return;
    }
    await handleNextSelection(platform, ctx, alternative, { allowChooseAnother: false });
    return;
  }
  if (choice === "Inspect session") {
    await presentSelectedSession(platform, ctx, selection.session, "status");
    return;
  }

  await runSelectedSession(platform, ctx, selection.session);
}

async function handleNext(platform: Platform, ctx: any): Promise<void> {
  if (!ctx.hasUI) {
    notifyWarning(ctx, "Ultraplan next requires interactive mode");
    return;
  }

  const state = loadSessionPickerState(platform, ctx);
  if (!state?.topRecommendation) {
    return;
  }

  await handleNextSelection(platform, ctx, {
    session: state.topRecommendation.session,
    recommendation: state.topRecommendation,
  });
}

export async function handleUltraplan(platform: Platform, ctx: any, args?: string): Promise<void> {
  const subcommand = parseUltraplanSubcommand(args);

  // Strip the subcommand from args before forwarding so handlers see only their own positional args.
  const subcommandArgs = args ? args.replace(/^\s*\S+\s*/, "").trim() : "";

  switch (subcommand) {
    case null:
      if (args?.trim()) {
        await handlePlan(platform, ctx, args);
      } else {
        await handleAuthoringBareEntry({ platform, ctx });
      }
      return;
    case "plan":
      await handlePlan(platform, ctx, subcommandArgs);
      return;
    case "discover":
      await handleStageSubcommand("discover", platform, ctx, subcommandArgs);
      return;
    case "research":
      await handleStageSubcommand("research", platform, ctx, subcommandArgs);
      return;
    case "synthesize":
      await handleStageSubcommand("synthesize", platform, ctx, subcommandArgs);
      return;
    case "review":
      await handleStageSubcommand("review", platform, ctx, subcommandArgs);
      return;
    case "approve":
      await handleStageSubcommand("approve", platform, ctx, subcommandArgs);
      return;
    case "resume":
      await handleResume(platform, ctx, subcommandArgs);
      return;
    case "quick":
      notifyWarning(
        ctx,
        "/supi:ultraplan quick is deprecated",
        "This single-shot path will be removed next release. Prefer /supi:ultraplan or /supi:ultraplan plan.",
      );
      await handleAuthoring(platform, ctx, subcommandArgs);
      return;
    case "run":
      await handleRun(platform, ctx, args);
      return;
    case "status":
      await handleStatus(platform, ctx);
      return;
    case "next":
      await handleNext(platform, ctx);
      return;
  }
}

function buildUltraPlanAuthoringPrompt(initialRequest: string): string {
  const requestSection = initialRequest.trim()
    ? ["Initial user prompt (verbatim):", "```", initialRequest.trim(), "```"]
    : [
      "No initial prompt was provided.",
      "Start by asking the user what they want this UltraPlan to accomplish.",
    ];

  return [
    "# UltraPlan conversational authoring",
    "",
    "You are authoring a new UltraPlan session from natural-language chat, not from command-line form fields.",
    "",
    ...requestSection,
    "",
    "## Interaction contract",
    "- Infer the title, one-line goal, applicable stacks (frontend/backend/infrastructure), domains, and scenarios from the user's prompt and repository context.",
    "- Ask clarifying questions only when the missing answer would materially change the plan.",
    "- When asking, keep it in chat. Prefer a structured question tool when available; give 2-5 suggested answers and mark the recommended one.",
    "- Always preserve an open-ended path: if the tool provides an automatic Other option, rely on it; otherwise explicitly say the user can type their own answer.",
    "- Do not ask the user to type JSON, rerun `/supi:ultraplan` with no arguments, or fill title/goal/domain TUI prompts.",
    "",
    "## Completion contract",
    "- Once you understand the request well enough, call `ultraplan_create` with the complete inferred plan.",
    "- Include only stacks that actually have work; every included stack needs at least one domain, and every domain needs at least one scenario.",
    "- Use scenario titles that are concrete execution targets. Add steps only when they clarify non-obvious sequencing or verification.",
    "- After `ultraplan_create` succeeds, summarize what was created and tell the user they can run `/supi:ultraplan run`.",
  ].join("\n");
}

async function handleAuthoring(platform: Platform, ctx: any, args?: string): Promise<void> {
  const initialRequest = args?.trim() ?? "";
  platform.sendMessage(
    {
      customType: "supi-ultraplan-author",
      content: [{ type: "text", text: buildUltraPlanAuthoringPrompt(initialRequest) }],
      display: "none",
    },
    { deliverAs: "steer", triggerTurn: true },
  );

  notifyInfo(
    ctx,
    "UltraPlan authoring started",
    initialRequest ? "The agent will refine the prompt in chat and save the plan when ready." : "Describe what you want to build; the agent will refine it in chat.",
  );
}

export function registerUltraplanCommand(platform: Platform): void {
  platform.registerCommand("supi:ultraplan", {
    description: "Author, run, inspect, or batch ultraplan sessions",
    getArgumentCompletions(prefix: string) {
      const lower = prefix.toLowerCase();
      const nestedRun = /^run\s+(.*)$/.exec(lower);
      if (nestedRun) {
        const nestedPrefix = nestedRun[1] ?? "";
        if ("batch".startsWith(nestedPrefix)) {
          return [
            {
              value: `run batch `,
              label: "run batch",
              description: "Start and supervise a batched run across multiple sessions",
            },
          ];
        }
        return null;
      }
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