/**
 * Storage helpers for harness pipeline artifacts.
 *
 * Mirrors `src/ultraplan/authoring/storage.ts`:
 *  - atomic write (temp + rename) for json/text;
 *  - structured `UltraPlanStorageResult` returns (reused so consumer ergonomics match);
 *  - append-only JSONL helpers tolerant of trailing partial lines after a crash.
 *
 * The harness keeps its own session manifest (no piggy-back on UltraPlan) so the two
 * pipelines stay independent. Callers should always go through this module — no raw `fs`
 * writes in stage code.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { PlatformPaths } from "../platform/types.js";
import { ensureTrailingNewline, normalizeLineEndings } from "../text.js";
import type {
  HarnessDesignSpec,
  HarnessDiscoverArtifact,
  HarnessPipelineEvent,
  HarnessSession,
  HarnessSlopQueueEntry,
  HarnessValidateReport,
  UltraPlanStorageError,
  UltraPlanStorageResult,
} from "../types.js";
import {
  getHarnessDecisionsPath,
  getHarnessDesignSpecJsonPath,
  getHarnessDiscoverPath,
  getHarnessDocsStagingDir,
  getHarnessDocsStagingLayerPath,
  getHarnessDocsStagingReadmePath,
  getHarnessImplementLogPath,
  getHarnessManifestPath,
  getHarnessPipelineLogPath,
  getHarnessQueuePath,
  getHarnessRepoDocsLayerPath,
  getHarnessRepoDocsLayersDir,
  getHarnessRepoDocsReadmePath,
  getHarnessRepoScorePath,
  getHarnessResearchTopicPath,
  getHarnessScoreHistoryPath,
  getHarnessSessionDir,
  getHarnessValidateReportPath,
  HARNESS_DOCS_LAYERS_DIRNAME,
} from "./project-paths.js";

// ---------------------------------------------------------------------------
// Result helpers
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

// ---------------------------------------------------------------------------
// Atomic writers
// ---------------------------------------------------------------------------

/**
 * Atomic JSON write: serialize → temp file → rename. The rename is atomic on the same
 * filesystem so concurrent readers see either the previous or the full new file, never a
 * half-written one.
 */
export function writeJsonAtomic(
  filePath: string,
  payload: unknown,
): UltraPlanStorageResult<string> {
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

export function writeTextAtomic(
  filePath: string,
  content: string,
): UltraPlanStorageResult<string> {
  try {
    ensureDir(filePath);
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, ensureTrailingNewline(normalizeLineEndings(content)));
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

/**
 * Append a JSON record as a single line. Tolerant of crashes mid-write: callers reading the
 * file should handle a trailing partial line by discarding it. See `readJsonl`.
 */
export function appendJsonl(
  filePath: string,
  record: unknown,
): UltraPlanStorageResult<string> {
  try {
    ensureDir(filePath);
    const line = `${JSON.stringify(record)}\n`;
    fs.appendFileSync(filePath, line);
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to append to ${filePath}`,
    );
  }
}

/**
 * Read a JSONL file, returning every well-formed record. A trailing partial line (no
 * newline terminator) is silently dropped — that's the crash-recovery path. Returns
 * `[]` when the file does not exist.
 */
export function readJsonl<T>(filePath: string): UltraPlanStorageResult<T[]> {
  if (!fs.existsSync(filePath)) return success([] as T[]);
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
  const lines = raw.split("\n");
  // The final element is "" if the file ends with `\n` (the well-formed case), or a
  // partial trailing record (the crash case). Either way, drop it.
  if (lines.length > 0) lines.pop();
  const records: T[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch (error) {
      return failure(
        filePath,
        "invalid-json",
        `Line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`,
      );
    }
  }
  return success(records);
}

/**
 * Atomically rewrite a JSONL file from a new array of records. Used for resolve operations
 * where an entry's state changes; we cannot append a `state` flip because the queue is
 * conceptually a set keyed by id.
 */
export function rewriteJsonl<T>(
  filePath: string,
  records: T[],
): UltraPlanStorageResult<string> {
  try {
    ensureDir(filePath);
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const content = records.length === 0 ? "" : records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to rewrite ${filePath}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Session manifest (per-pipeline-run state).
// ---------------------------------------------------------------------------

export function saveHarnessSession(
  paths: PlatformPaths,
  cwd: string,
  session: HarnessSession,
): UltraPlanStorageResult<string> {
  return writeJsonAtomic(getHarnessManifestPath(paths, cwd, session.sessionId), session);
}

export function loadHarnessSession(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<HarnessSession> {
  const result = readJsonFile(getHarnessManifestPath(paths, cwd, sessionId));
  if (!result.ok) return result;
  return success(result.value as HarnessSession);
}

/** List every harness session id under the project root. Missing dir → empty list. */
export function listHarnessSessions(paths: PlatformPaths, cwd: string): string[] {
  const dir = getHarnessSessionDirParent(paths, cwd);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function getHarnessSessionDirParent(paths: PlatformPaths, cwd: string): string {
  // sessionId="" returns the parent dir without a trailing sessionId segment.
  return path.dirname(getHarnessSessionDir(paths, cwd, "_"));
}

// ---------------------------------------------------------------------------
// Stage artifacts
// ---------------------------------------------------------------------------

export function saveHarnessDiscover(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  artifact: HarnessDiscoverArtifact,
): UltraPlanStorageResult<string> {
  return writeJsonAtomic(getHarnessDiscoverPath(paths, cwd, sessionId), artifact);
}

export function loadHarnessDiscover(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<HarnessDiscoverArtifact> {
  const result = readJsonFile(getHarnessDiscoverPath(paths, cwd, sessionId));
  if (!result.ok) return result;
  return success(result.value as HarnessDiscoverArtifact);
}

export function saveHarnessResearchTopic(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  topicSlug: string,
  markdown: string,
): UltraPlanStorageResult<string> {
  return writeTextAtomic(
    getHarnessResearchTopicPath(paths, cwd, sessionId, topicSlug),
    markdown,
  );
}

export function loadHarnessResearchTopic(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  topicSlug: string,
): UltraPlanStorageResult<string> {
  return readTextFile(getHarnessResearchTopicPath(paths, cwd, sessionId, topicSlug));
}

export function saveHarnessDesignSpec(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  markdown: string,
): UltraPlanStorageResult<string> {
  // Design spec is markdown.
  const filePath = path.join(
    getHarnessSessionDir(paths, cwd, sessionId),
    "design-spec.md",
  );
  return writeTextAtomic(filePath, markdown);
}

export function loadHarnessDesignSpec(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<string> {
  const filePath = path.join(
    getHarnessSessionDir(paths, cwd, sessionId),
    "design-spec.md",
  );
  return readTextFile(filePath);
}

export function saveHarnessDesignSpecJson(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  spec: HarnessDesignSpec,
): UltraPlanStorageResult<string> {
  return writeJsonAtomic(
    getHarnessDesignSpecJsonPath(paths, cwd, sessionId),
    spec,
  );
}

export function loadHarnessDesignSpecJson(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<HarnessDesignSpec> {
  const result = readJsonFile(
    getHarnessDesignSpecJsonPath(paths, cwd, sessionId),
  );
  if (!result.ok) return result;
  return success(result.value as HarnessDesignSpec);
}

export function appendHarnessDecision(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  decision: Record<string, unknown>,
): UltraPlanStorageResult<string> {
  return appendJsonl(getHarnessDecisionsPath(paths, cwd, sessionId), decision);
}

export function saveHarnessValidateReport(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  report: HarnessValidateReport,
): UltraPlanStorageResult<string> {
  return writeJsonAtomic(getHarnessValidateReportPath(paths, cwd, sessionId), report);
}

export function loadHarnessValidateReport(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<HarnessValidateReport> {
  const result = readJsonFile(getHarnessValidateReportPath(paths, cwd, sessionId));
  if (!result.ok) return result;
  return success(result.value as HarnessValidateReport);
}

// ---------------------------------------------------------------------------
// Pipeline + implement logs (append-only JSONL)
// ---------------------------------------------------------------------------

export function appendPipelineLog(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  event: HarnessPipelineEvent,
): UltraPlanStorageResult<string> {
  return appendJsonl(getHarnessPipelineLogPath(paths, cwd, sessionId), event);
}

export function appendImplementLog(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  record: Record<string, unknown>,
): UltraPlanStorageResult<string> {
  return appendJsonl(getHarnessImplementLogPath(paths, cwd, sessionId), record);
}

/**
 * Return true if the implement log records a successful programmatic apply for this
 * session: the most recent record has `kind: "applied"` and an empty `errors` array.
 * Used by `HarnessImplementStage.isComplete` to fast-skip reruns.
 */
export function hasSuccessfulImplementApply(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): boolean {
  const logPath = getHarnessImplementLogPath(paths, cwd, sessionId);
  if (!fs.existsSync(logPath)) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return false;
  }
  // Scan from the end so a later failed re-apply correctly overrides an earlier success.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const r = record as { kind?: unknown; errors?: unknown };
    if (r.kind !== "applied") continue;
    const errCount = Array.isArray(r.errors) ? r.errors.length : 0;
    return errCount === 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Project-scoped queue + score (shared across worktrees)
// ---------------------------------------------------------------------------

/** Append a single queue entry (state defaults to "open"). */
export function appendSlopQueueEntry(
  paths: PlatformPaths,
  cwd: string,
  entry: HarnessSlopQueueEntry,
): UltraPlanStorageResult<string> {
  return appendJsonl(getHarnessQueuePath(paths, cwd), entry);
}

/** Read every queue entry. Crash-tolerant. */
export function readSlopQueue(
  paths: PlatformPaths,
  cwd: string,
): UltraPlanStorageResult<HarnessSlopQueueEntry[]> {
  return readJsonl<HarnessSlopQueueEntry>(getHarnessQueuePath(paths, cwd));
}

/** Atomically rewrite the queue (used by resolve/wontfix). */
export function rewriteSlopQueue(
  paths: PlatformPaths,
  cwd: string,
  entries: HarnessSlopQueueEntry[],
): UltraPlanStorageResult<string> {
  return rewriteJsonl(getHarnessQueuePath(paths, cwd), entries);
}

/** Save the repo-local score snapshot (committable). */
export function saveHarnessRepoScore(
  paths: PlatformPaths,
  cwd: string,
  score: unknown,
): UltraPlanStorageResult<string> {
  return writeJsonAtomic(getHarnessRepoScorePath(paths, cwd), score);
}

/** Append a score-history entry (JSONL). */
export function appendScoreHistory(
  paths: PlatformPaths,
  cwd: string,
  record: Record<string, unknown>,
): UltraPlanStorageResult<string> {
  return appendJsonl(getHarnessScoreHistoryPath(paths, cwd), record);
}

// ---------------------------------------------------------------------------
// Docs stage — staging + repo promotion.
// ---------------------------------------------------------------------------

/** Save a single layer doc into the session's staging area. Atomic write. */
export function saveHarnessDocsLayerStaging(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  layerId: string,
  markdown: string,
): UltraPlanStorageResult<string> {
  return writeTextAtomic(
    getHarnessDocsStagingLayerPath(paths, cwd, sessionId, layerId),
    markdown,
  );
}

/** Read a single staged layer doc. */
export function loadHarnessDocsLayerStaging(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  layerId: string,
): UltraPlanStorageResult<string> {
  return readTextFile(getHarnessDocsStagingLayerPath(paths, cwd, sessionId, layerId));
}

/** List staged layer ids (file basenames without `.md`). Returns [] when dir is absent. */
export function listHarnessDocsLayerStaging(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): string[] {
  const dir = path.join(
    getHarnessDocsStagingDir(paths, cwd, sessionId),
    HARNESS_DOCS_LAYERS_DIRNAME,
  );
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/** Save the staged docs index. Atomic write. */
export function saveHarnessDocsIndexStaging(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  markdown: string,
): UltraPlanStorageResult<string> {
  return writeTextAtomic(getHarnessDocsStagingReadmePath(paths, cwd, sessionId), markdown);
}

/**
 * Promote staged docs to the repo-local docs/ tree.
 *
 * Atomicity contract: layer docs are written first (each via temp → rename); the index
 * is written last so an observer reading mid-promotion never sees an index pointing at
 * a yet-to-land layer doc. A failure midway leaves the previous repo state in place for
 * already-rewritten files only when their layer was earlier in the list — callers must
 * therefore treat partial failures as a "blocked" outcome and rely on the next run to
 * re-promote from staging.
 */
export function promoteHarnessDocsToRepo(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  layerIds: readonly string[],
): UltraPlanStorageResult<{ layerPaths: string[]; indexPath: string }> {
  fs.mkdirSync(getHarnessRepoDocsLayersDir(paths, cwd), { recursive: true });

  const layerPaths: string[] = [];
  for (const layerId of layerIds) {
    const staged = loadHarnessDocsLayerStaging(paths, cwd, sessionId, layerId);
    if (!staged.ok) return staged;
    const repoPath = getHarnessRepoDocsLayerPath(paths, cwd, layerId);
    const wrote = writeTextAtomic(repoPath, staged.value);
    if (!wrote.ok) return wrote;
    layerPaths.push(wrote.value);
  }

  const indexStaged = readTextFile(getHarnessDocsStagingReadmePath(paths, cwd, sessionId));
  if (!indexStaged.ok) return indexStaged;
  const indexRepo = getHarnessRepoDocsReadmePath(paths, cwd);
  const wroteIndex = writeTextAtomic(indexRepo, indexStaged.value);
  if (!wroteIndex.ok) return wroteIndex;

  return success({ layerPaths, indexPath: wroteIndex.value });
}
