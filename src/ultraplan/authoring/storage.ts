/**
 * Storage helpers for the multi-stage authoring pipeline.
 *
 * Authoring artifacts live under `<session>/authoring/` and never touch the runtime tracker
 * or the canonical `authored.json` until the APPROVE stage promotes them. This module is a
 * thin wrapper over `node:fs` that:
 *  - validates each artifact against its TypeBox schema before writing,
 *  - writes JSON atomically (temp + rename),
 *  - appends to `pipeline-log.jsonl` line-by-line (no rewriting the whole file),
 *  - exposes load helpers that distinguish "missing" from "invalid" cleanly.
 *
 * Filesystem failures are returned as structured `UltraPlanStorageResult` values so callers
 * never need to wrap calls in try/catch. The shape mirrors `src/ultraplan/storage.ts` and the
 * runtime `tracker-storage.ts` deliberately so the consumer ergonomics are identical.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { PlatformPaths } from "../../platform/types.js";
import type {
  UltraPlanAuthoringFindingsArtifact,
  UltraPlanAuthoringPipelineEvent,
  UltraPlanAuthoringState,
  UltraPlanStackId,
  UltraPlanStorageError,
  UltraPlanStorageResult,
} from "../../types.js";
import {
  validateUltraPlanAuthoringFindingsArtifact,
  validateUltraPlanAuthoringPipelineEvent,
  validateUltraPlanAuthoringState,
} from "../contracts.js";
import {
  getUltraplanAuthoringDecisionsPath,
  getUltraplanAuthoringDeferredIdeasPath,
  getUltraplanAuthoringDir,
  getUltraplanAuthoringDiscussPath,
  getUltraplanAuthoringDraftAuthoredJsonPath,
  getUltraplanAuthoringDraftAuthoredMarkdownPath,
  getUltraplanAuthoringDraftFindingsPath,
  getUltraplanAuthoringDraftIterationDir,
  getUltraplanAuthoringDraftPlannerJsonPath,
  getUltraplanAuthoringIntakePath,
  getUltraplanAuthoringPipelineLogPath,
  getUltraplanAuthoringResearchStackPath,
  getUltraplanAuthoringResearchSummaryPath,
  getUltraplanAuthoringScoutPath,
} from "../project-paths.js";
import { loadUltraPlanManifest, saveUltraPlanManifest } from "../storage.js";

// ---------------------------------------------------------------------------
// Result helpers (kept private; matches the shape used elsewhere in storage.ts).
// ---------------------------------------------------------------------------

function success<T>(value: T): UltraPlanStorageResult<T> {
  return { ok: true, value };
}

function failure(
  pathname: string,
  kind: UltraPlanStorageError["kind"],
  message: string,
  details?: string[],
): UltraPlanStorageResult<never> {
  return {
    ok: false,
    error: {
      kind,
      path: pathname,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function ensureDirExists(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Atomic JSON write: serialize → write to a per-process temp file → rename. The rename is
 * atomic on the same filesystem, so concurrent readers either see the previous file or the
 * full new file, never a half-written one.
 */
function writeJsonAtomic(filePath: string, payload: unknown): UltraPlanStorageResult<string> {
  try {
    ensureDir(filePath);
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(tmpPath, filePath);
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to write ${filePath}`,
    );
  }
}

/**
 * Atomic text write (markdown, decisions, deferred ideas). Same temp+rename strategy.
 */
function writeTextAtomic(filePath: string, content: string): UltraPlanStorageResult<string> {
  try {
    ensureDir(filePath);
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, content.endsWith("\n") ? content : `${content}\n`);
    fs.renameSync(tmpPath, filePath);
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to write ${filePath}`,
    );
  }
}

function readJsonFile(filePath: string): UltraPlanStorageResult<unknown> {
  if (!fs.existsSync(filePath)) {
    return failure(filePath, "missing", `Artifact not found: ${filePath}`);
  }
  try {
    return success(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    return failure(
      filePath,
      "invalid-json",
      error instanceof Error ? error.message : `Invalid JSON in ${filePath}`,
    );
  }
}

function readTextFile(filePath: string): UltraPlanStorageResult<string> {
  if (!fs.existsSync(filePath)) {
    return failure(filePath, "missing", `Artifact not found: ${filePath}`);
  }
  try {
    return success(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to read ${filePath}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Authoring state (the manifest's `authoring` block).
//
// The state lives inside the manifest, not in a sibling file: the manifest is already the
// canonical truth for "what session is this and what state is it in," and the authoring
// block is just an extension of that. We expose load/save helpers that go through the
// manifest so callers don't need to know the embedding.
// ---------------------------------------------------------------------------

/**
 * Load just the authoring block from the manifest. Returns `null` (wrapped in success) when
 * the manifest exists but has no authoring block — this is the common case for legacy
 * single-shot sessions and for sessions that have been promoted to `state: "ready"`.
 */
export function loadAuthoringState(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<UltraPlanAuthoringState | null> {
  const manifestResult = loadUltraPlanManifest(paths, cwd, sessionId);
  if (!manifestResult.ok) return manifestResult;
  return success(manifestResult.value.authoring ?? null);
}

/**
 * Persist the authoring state by overwriting the manifest's `authoring` field. The full
 * manifest is round-tripped through schema validation before being written, so this also
 * implicitly validates the authoring block against `UltraPlanAuthoringStateSchema`.
 *
 * Pre-validates the authoring block independently for a clearer error path — callers see
 * the authoring-specific errors instead of a manifest-shaped error message.
 */
export function saveAuthoringState(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  authoring: UltraPlanAuthoringState,
): UltraPlanStorageResult<string> {
  const validation = validateUltraPlanAuthoringState(authoring);
  if (!validation.ok) {
    return failure(
      "authoring-state",
      "validation-error",
      "Authoring state failed schema validation",
      validation.errors,
    );
  }

  const manifestResult = loadUltraPlanManifest(paths, cwd, sessionId);
  if (!manifestResult.ok) return manifestResult;

  const next = { ...manifestResult.value, authoring: validation.value, updatedAt: new Date().toISOString() };
  const saved = saveUltraPlanManifest(paths, cwd, sessionId, next);
  return saved;
}

/**
 * Clear the authoring block. Used by the APPROVE stage after the canonical artifacts are
 * promoted. Equivalent to `saveAuthoringState` with `undefined`, but the underlying manifest
 * schema makes the field optional so we explicitly drop it.
 */
export function clearAuthoringState(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<string> {
  const manifestResult = loadUltraPlanManifest(paths, cwd, sessionId);
  if (!manifestResult.ok) return manifestResult;
  const { authoring: _drop, ...rest } = manifestResult.value;
  void _drop;
  const next = { ...rest, updatedAt: new Date().toISOString() };
  return saveUltraPlanManifest(paths, cwd, sessionId, next);
}

// ---------------------------------------------------------------------------
// Stage artifacts (intake, scout, discuss, deferred-ideas, research/<stack>.md, drafts).
// JSON artifacts go through schema validation; markdown artifacts are stored as opaque text.
// ---------------------------------------------------------------------------

export function saveIntakeArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  artifact: unknown,
): UltraPlanStorageResult<string> {
  // The intake schema is owned by the intake stage runner (Phase 3) — at the substrate level
  // we accept any JSON that round-trips, so legacy callers and tests can drop any object.
  return writeJsonAtomic(getUltraplanAuthoringIntakePath(paths, cwd, sessionId), artifact);
}

export function loadIntakeArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<unknown> {
  return readJsonFile(getUltraplanAuthoringIntakePath(paths, cwd, sessionId));
}

export function saveScoutArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  artifact: unknown,
): UltraPlanStorageResult<string> {
  return writeJsonAtomic(getUltraplanAuthoringScoutPath(paths, cwd, sessionId), artifact);
}

export function loadScoutArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<unknown> {
  return readJsonFile(getUltraplanAuthoringScoutPath(paths, cwd, sessionId));
}

export function saveDiscussArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  markdown: string,
): UltraPlanStorageResult<string> {
  return writeTextAtomic(getUltraplanAuthoringDiscussPath(paths, cwd, sessionId), markdown);
}

export function loadDiscussArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<string> {
  return readTextFile(getUltraplanAuthoringDiscussPath(paths, cwd, sessionId));
}

export function saveDeferredIdeas(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  markdown: string,
): UltraPlanStorageResult<string> {
  return writeTextAtomic(getUltraplanAuthoringDeferredIdeasPath(paths, cwd, sessionId), markdown);
}

export function loadDeferredIdeas(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<string> {
  return readTextFile(getUltraplanAuthoringDeferredIdeasPath(paths, cwd, sessionId));
}

/** Append a single decision JSONL line. Caller is responsible for the schema/shape. */
export function appendDecisionRecord(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  decision: Record<string, unknown>,
): UltraPlanStorageResult<string> {
  const filePath = getUltraplanAuthoringDecisionsPath(paths, cwd, sessionId);
  try {
    ensureDir(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(decision)}\n`);
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to append decision to ${filePath}`,
    );
  }
}

export function saveResearchStackArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stack: UltraPlanStackId,
  markdown: string,
): UltraPlanStorageResult<string> {
  return writeTextAtomic(getUltraplanAuthoringResearchStackPath(paths, cwd, sessionId, stack), markdown);
}

export function loadResearchStackArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stack: UltraPlanStackId,
): UltraPlanStorageResult<string> {
  return readTextFile(getUltraplanAuthoringResearchStackPath(paths, cwd, sessionId, stack));
}

/**
 * Remove a per-stack research artifact. Used when a stack flips from `applicable` to
 * `not-applicable` mid-pipeline (the skip-stack invariant in Phase 5). Missing files are a
 * no-op, not an error.
 */
export function deleteResearchStackArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stack: UltraPlanStackId,
): UltraPlanStorageResult<string> {
  const filePath = getUltraplanAuthoringResearchStackPath(paths, cwd, sessionId, stack);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to delete ${filePath}`,
    );
  }
}

export function saveResearchSummary(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  markdown: string,
): UltraPlanStorageResult<string> {
  return writeTextAtomic(getUltraplanAuthoringResearchSummaryPath(paths, cwd, sessionId), markdown);
}

export function loadResearchSummary(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<string> {
  return readTextFile(getUltraplanAuthoringResearchSummaryPath(paths, cwd, sessionId));
}

// ---------------------------------------------------------------------------
// Drafts: per-iteration directories under `drafts/iteration-N/`.
// ---------------------------------------------------------------------------

export function ensureDraftIterationDir(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  iteration: number,
): string {
  const dir = getUltraplanAuthoringDraftIterationDir(paths, cwd, sessionId, iteration);
  ensureDirExists(dir);
  return dir;
}

export function saveDraftAuthoredJson(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  iteration: number,
  artifact: unknown,
): UltraPlanStorageResult<string> {
  return writeJsonAtomic(
    getUltraplanAuthoringDraftAuthoredJsonPath(paths, cwd, sessionId, iteration),
    artifact,
  );
}

export function loadDraftAuthoredJson(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  iteration: number,
): UltraPlanStorageResult<unknown> {
  return readJsonFile(getUltraplanAuthoringDraftAuthoredJsonPath(paths, cwd, sessionId, iteration));
}

export function saveDraftAuthoredMarkdown(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  iteration: number,
  markdown: string,
): UltraPlanStorageResult<string> {
  return writeTextAtomic(
    getUltraplanAuthoringDraftAuthoredMarkdownPath(paths, cwd, sessionId, iteration),
    markdown,
  );
}

export function loadDraftAuthoredMarkdown(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  iteration: number,
): UltraPlanStorageResult<string> {
  return readTextFile(getUltraplanAuthoringDraftAuthoredMarkdownPath(paths, cwd, sessionId, iteration));
}

/**
 * Snapshot the planner's emitted draft before any user editing happens. Stored alongside the
 * editable draft so forensics can compare what the planner wrote vs. what the user shipped.
 */
export function saveDraftPlannerJson(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  iteration: number,
  artifact: unknown,
): UltraPlanStorageResult<string> {
  return writeJsonAtomic(
    getUltraplanAuthoringDraftPlannerJsonPath(paths, cwd, sessionId, iteration),
    artifact,
  );
}

export function saveFindingsArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  iteration: number,
  findings: UltraPlanAuthoringFindingsArtifact,
): UltraPlanStorageResult<string> {
  const validation = validateUltraPlanAuthoringFindingsArtifact(findings);
  if (!validation.ok) {
    return failure(
      "findings-artifact",
      "validation-error",
      "Findings artifact failed schema validation",
      validation.errors,
    );
  }
  return writeJsonAtomic(
    getUltraplanAuthoringDraftFindingsPath(paths, cwd, sessionId, iteration),
    validation.value,
  );
}

export function loadFindingsArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  iteration: number,
): UltraPlanStorageResult<UltraPlanAuthoringFindingsArtifact> {
  const filePath = getUltraplanAuthoringDraftFindingsPath(paths, cwd, sessionId, iteration);
  const parsed = readJsonFile(filePath);
  if (!parsed.ok) return parsed;
  const validation = validateUltraPlanAuthoringFindingsArtifact(parsed.value);
  if (!validation.ok) {
    return failure(filePath, "validation-error", `Findings failed schema validation: ${filePath}`, validation.errors);
  }
  return success(validation.value);
}

// ---------------------------------------------------------------------------
// Pipeline log (append-only JSONL).
// ---------------------------------------------------------------------------

/**
 * Append a single event to `pipeline-log.jsonl`. The event is validated against
 * `UltraPlanAuthoringPipelineEventSchema` so malformed entries never reach disk.
 *
 * `fs.appendFileSync` is sufficient here because line-oriented writes < PIPE_BUF are atomic
 * on POSIX, and Windows serializes `appendFileSync` calls within a process. Concurrent
 * authoring runs across different session IDs write to different files, so contention is
 * not a concern.
 */
export function appendPipelineLog(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  event: UltraPlanAuthoringPipelineEvent,
): UltraPlanStorageResult<string> {
  const validation = validateUltraPlanAuthoringPipelineEvent(event);
  if (!validation.ok) {
    return failure(
      "pipeline-log-event",
      "validation-error",
      "Pipeline event failed schema validation",
      validation.errors,
    );
  }

  const filePath = getUltraplanAuthoringPipelineLogPath(paths, cwd, sessionId);
  try {
    ensureDir(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(validation.value)}\n`);
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to append pipeline log entry to ${filePath}`,
    );
  }
}

/**
 * Read the full pipeline log into memory. Returns an empty array on missing file (this is
 * the common state on a brand-new authoring session). Lines that fail schema validation are
 * skipped silently — a corrupt log line should not block the picker or status presenter.
 */
export function readPipelineLog(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<UltraPlanAuthoringPipelineEvent[]> {
  const filePath = getUltraplanAuthoringPipelineLogPath(paths, cwd, sessionId);
  if (!fs.existsSync(filePath)) {
    return success([]);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to read ${filePath}`,
    );
  }
  const events: UltraPlanAuthoringPipelineEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const validation = validateUltraPlanAuthoringPipelineEvent(parsed);
    if (validation.ok) {
      events.push(validation.value);
    }
  }
  return success(events);
}

/**
 * Convenience: returns whether an authoring directory exists for the session. Cheap check
 * used by the resume picker.
 */
export function hasAuthoringWorkspace(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): boolean {
  return fs.existsSync(getUltraplanAuthoringDir(paths, cwd, sessionId));
}
