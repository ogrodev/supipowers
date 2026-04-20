import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type {
  UltraPlanAuthoredArtifact,
  UltraPlanDomainReview,
  UltraPlanIndex,
  UltraPlanManifest,
  UltraPlanSessionSummary,
  UltraPlanStackId,
  UltraPlanStackReview,
  UltraPlanStorageError,
  UltraPlanStorageResult,
} from "../types.js";
import {
  getUltraPlanSchemaErrors,
  UltraPlanDomainReviewSchema,
  UltraPlanStackReviewSchema,
  validateUltraPlanAuthoredArtifact,
  validateUltraPlanIndex,
  validateUltraPlanManifest,
} from "./contracts.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanDomainReviewPath,
  getUltraplanIndexPath,
  getUltraplanManifestPath,
  getUltraplanSessionDir,
  getUltraplanStackReviewPath,
} from "./project-paths.js";

function success<T>(value: T): UltraPlanStorageResult<T> {
  return { ok: true, value };
}

function failure(pathname: string, kind: UltraPlanStorageError["kind"], message: string, details?: string[]): UltraPlanStorageResult<never> {
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

function writeJsonFile(filePath: string, payload: unknown): UltraPlanStorageResult<string> {
  try {
    ensureDir(filePath);
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to write ${filePath}`,
    );
  }
}

function resolveSessionArtifactPath(sessionDir: string, artifactPath: string): string {
  return path.isAbsolute(artifactPath) ? artifactPath : path.join(sessionDir, artifactPath);
}

function loadValidatedArtifact<T>(
  filePath: string,
  validate: (value: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
): UltraPlanStorageResult<T> {
  const parsed = readJsonFile(filePath);
  if (!parsed.ok) {
    return parsed;
  }

  const validation = validate(parsed.value);
  if (!validation.ok) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, validation.errors);
  }

  return success(validation.value);
}

function loadOptionalValidatedArtifact<T>(
  filePath: string,
  schemaErrors: (value: unknown) => string[],
): UltraPlanStorageResult<T | null> {
  if (!fs.existsSync(filePath)) {
    return success(null);
  }

  const parsed = readJsonFile(filePath);
  if (!parsed.ok) {
    return parsed;
  }

  const errors = schemaErrors(parsed.value);
  if (errors.length > 0) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, errors);
  }

  return success(parsed.value as T);
}

export function saveUltraPlanIndex(
  paths: PlatformPaths,
  cwd: string,
  index: UltraPlanIndex,
): UltraPlanStorageResult<string> {
  const validation = validateUltraPlanIndex(index);
  if (!validation.ok) {
    const filePath = getUltraplanIndexPath(paths, cwd);
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, validation.errors);
  }

  return writeJsonFile(getUltraplanIndexPath(paths, cwd), validation.value);
}

export function loadUltraPlanIndex(paths: PlatformPaths, cwd: string): UltraPlanStorageResult<UltraPlanIndex> {
  const filePath = getUltraplanIndexPath(paths, cwd);
  if (!fs.existsSync(filePath)) {
    return failure(filePath, "missing", `Artifact not found: ${filePath}`);
  }

  return loadValidatedArtifact(filePath, validateUltraPlanIndex);
}

export function saveUltraPlanManifest(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  manifest: UltraPlanManifest,
): UltraPlanStorageResult<string> {
  const filePath = getUltraplanManifestPath(paths, cwd, sessionId);
  const validation = validateUltraPlanManifest(manifest);
  if (!validation.ok) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, validation.errors);
  }

  return writeJsonFile(filePath, validation.value);
}

export function loadUltraPlanManifest(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<UltraPlanManifest> {
  return loadValidatedArtifact(getUltraplanManifestPath(paths, cwd, sessionId), validateUltraPlanManifest);
}

export function saveUltraPlanAuthoredArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  authored: UltraPlanAuthoredArtifact,
): UltraPlanStorageResult<string> {
  const filePath = getUltraplanAuthoredJsonPath(paths, cwd, sessionId);
  const validation = validateUltraPlanAuthoredArtifact(authored);
  if (!validation.ok) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, validation.errors);
  }

  return writeJsonFile(filePath, validation.value);
}

export function loadUltraPlanAuthoredArtifact(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<UltraPlanAuthoredArtifact> {
  return loadValidatedArtifact(getUltraplanAuthoredJsonPath(paths, cwd, sessionId), validateUltraPlanAuthoredArtifact);
}

export function loadUltraPlanDomainReview(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stack: UltraPlanStackId,
  domainId: string,
): UltraPlanStorageResult<UltraPlanDomainReview | null> {
  return loadOptionalValidatedArtifact<UltraPlanDomainReview>(
    getUltraplanDomainReviewPath(paths, cwd, sessionId, stack, domainId),
    (value) => getUltraPlanSchemaErrors(UltraPlanDomainReviewSchema, value),
  );
}

export function loadUltraPlanStackReview(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stack: UltraPlanStackId,
): UltraPlanStorageResult<UltraPlanStackReview | null> {
  return loadOptionalValidatedArtifact<UltraPlanStackReview>(
    getUltraplanStackReviewPath(paths, cwd, sessionId, stack),
    (value) => getUltraPlanSchemaErrors(UltraPlanStackReviewSchema, value),
  );
}

function validatePassedReviewReference(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  review: UltraPlanManifest["reviews"][number],
): UltraPlanStorageResult<null> {
  if (review.status !== "passed") {
    return success(null);
  }

  const sessionDir = getUltraplanSessionDir(paths, cwd, sessionId);
  const referencedPath = resolveSessionArtifactPath(sessionDir, review.path);

  if (review.type === "domain") {
    if (!review.domainId) {
      return failure(referencedPath, "validation-error", "Passed domain review reference is missing a domainId");
    }

    const expectedPath = getUltraplanDomainReviewPath(paths, cwd, sessionId, review.stack, review.domainId);
    if (referencedPath !== expectedPath) {
      return failure(referencedPath, "validation-error", `Passed domain review reference points at an unexpected artifact path: ${referencedPath}`);
    }

    const domainReview = loadUltraPlanDomainReview(paths, cwd, sessionId, review.stack, review.domainId);
    if (!domainReview.ok) {
      return domainReview;
    }
    if (!domainReview.value) {
      return failure(expectedPath, "missing", `Passed domain review reference is missing review artifact: ${expectedPath}`);
    }
    if (domainReview.value.status !== "passed" || domainReview.value.stack !== review.stack || domainReview.value.domainId !== review.domainId) {
      return failure(expectedPath, "validation-error", `Passed domain review reference does not match the validated review artifact: ${expectedPath}`);
    }

    return success(null);
  }

  if (review.domainId !== null) {
    return failure(referencedPath, "validation-error", "Stack review references must not include a domainId");
  }

  const expectedPath = getUltraplanStackReviewPath(paths, cwd, sessionId, review.stack);
  if (referencedPath !== expectedPath) {
    return failure(referencedPath, "validation-error", `Passed stack review reference points at an unexpected artifact path: ${referencedPath}`);
  }

  const stackReview = loadUltraPlanStackReview(paths, cwd, sessionId, review.stack);
  if (!stackReview.ok) {
    return stackReview;
  }
  if (!stackReview.value) {
    return failure(expectedPath, "missing", `Passed stack review reference is missing review artifact: ${expectedPath}`);
  }
  if (stackReview.value.status !== "passed" || stackReview.value.stack !== review.stack) {
    return failure(expectedPath, "validation-error", `Passed stack review reference does not match the validated review artifact: ${expectedPath}`);
  }

  return success(null);
}


export function loadUltraPlanSessionSummary(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<UltraPlanSessionSummary> {
  const manifest = loadUltraPlanManifest(paths, cwd, sessionId);
  if (!manifest.ok) {
    return manifest;
  }

  const manifestValue = manifest.value;
  for (const review of manifestValue.reviews) {
    const reviewValidation = validatePassedReviewReference(paths, cwd, sessionId, review);
    if (!reviewValidation.ok) {
      return reviewValidation;
    }
  }

  return success({
    sessionId: manifestValue.sessionId,
    projectName: manifestValue.projectName,
    title: manifestValue.title,
    state: manifestValue.state,
    createdAt: manifestValue.createdAt,
    updatedAt: manifestValue.updatedAt,
    cursor: manifestValue.cursor,
    lastCompleted: manifestValue.lastCompleted,
    blocker: manifestValue.blocker,
    progress: manifestValue.progress,
    stacks: manifestValue.stacks,
    reviews: manifestValue.reviews,
  });
}
