import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanAuthoredMarkdownPath,
  getUltraplanDomainReviewPath,
  getUltraplanExecutionLogPath,
  getUltraplanHooksLogPath,
  getUltraplanIndexPath,
  getUltraplanManifestPath,
  getUltraplanMigrationRecordPath,
  getUltraplanProjectDir,
  getUltraplanProjectName,
  getUltraplanReviewDir,
  getUltraplanRuntimeTrackerPath,
  getUltraplanSessionDir,
  getUltraplanStackReviewDir,
  getUltraplanStackReviewPath,
  getUltraplansDir,
  resolveUltraPlanRoot,
} from "../../src/ultraplan/project-paths.js";
import { projectSlugFromRepoRoot } from "../../src/ultraplan/runtime/project-slug.js";
import { createTestPaths, createTestRepo } from "./fixtures.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-paths-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ultraplan project paths", () => {
  test("derives the project name from the resolved repo root", () => {
    const { repoRoot, subdir } = createTestRepo(tmpDir);

    expect(getUltraplanProjectName(repoRoot)).toBe("supipowers");
    expect(getUltraplanProjectName(subdir)).toBe("supipowers");
  });

  test("resolveUltraPlanRoot returns ${home}/.omp/supipowers/projects/<slug>/ultraplans", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot, subdir } = createTestRepo(tmpDir);
    const slug = projectSlugFromRepoRoot(repoRoot);

    const expected = paths.global("projects", slug, "ultraplans");
    expect(resolveUltraPlanRoot(paths, repoRoot)).toBe(expected);
    expect(resolveUltraPlanRoot(paths, subdir)).toBe(expected);
  });

  test("stores ultraplan directories under the global root scoped by project slug", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot, subdir } = createTestRepo(tmpDir);
    const slug = projectSlugFromRepoRoot(repoRoot);
    const projectDir = paths.global("projects", slug);
    const ultraplansDir = paths.global("projects", slug, "ultraplans");

    expect(getUltraplanProjectDir(paths, repoRoot)).toBe(projectDir);
    expect(getUltraplanProjectDir(paths, subdir)).toBe(projectDir);
    expect(getUltraplansDir(paths, subdir)).toBe(ultraplansDir);
    expect(getUltraplanIndexPath(paths, subdir)).toBe(path.join(ultraplansDir, "index.json"));
  });

  test("builds exact session artifact paths from the resolved repo root", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot, subdir } = createTestRepo(tmpDir);
    const slug = projectSlugFromRepoRoot(repoRoot);
    const sessionId = "up-123";
    const sessionDir = paths.global("projects", slug, "ultraplans", sessionId);

    expect(getUltraplanSessionDir(paths, subdir, sessionId)).toBe(sessionDir);
    expect(getUltraplanManifestPath(paths, subdir, sessionId)).toBe(
      path.join(sessionDir, "manifest.json"),
    );
    expect(getUltraplanAuthoredJsonPath(paths, subdir, sessionId)).toBe(
      path.join(sessionDir, "authored.json"),
    );
    expect(getUltraplanAuthoredMarkdownPath(paths, subdir, sessionId)).toBe(
      path.join(sessionDir, "authored.md"),
    );
    expect(getUltraplanExecutionLogPath(paths, subdir, sessionId)).toBe(
      path.join(sessionDir, "execution-log.jsonl"),
    );
    expect(getUltraplanHooksLogPath(paths, subdir, sessionId)).toBe(
      path.join(sessionDir, "hooks-log.jsonl"),
    );
    expect(getUltraplanReviewDir(paths, subdir, sessionId)).toBe(
      path.join(sessionDir, "review"),
    );
    expect(getUltraplanStackReviewDir(paths, subdir, sessionId, "frontend")).toBe(
      path.join(sessionDir, "review", "frontend"),
    );
    expect(getUltraplanDomainReviewPath(paths, subdir, sessionId, "frontend", "auth")).toBe(
      path.join(sessionDir, "review", "frontend", "domains", "auth.json"),
    );
    expect(getUltraplanStackReviewPath(paths, subdir, sessionId, "frontend")).toBe(
      path.join(sessionDir, "review", "frontend", "stack.json"),
    );
    expect(getUltraplanRuntimeTrackerPath(paths, subdir, sessionId)).toBe(
      path.join(sessionDir, "runtime-tracker.json"),
    );
    expect(getUltraplanMigrationRecordPath(paths, subdir, sessionId)).toBe(
      path.join(sessionDir, "migration.json"),
    );
  });

  test("all helpers resolve through resolveUltraPlanRoot for a given cwd", () => {
    const paths = createTestPaths(tmpDir);
    const { subdir } = createTestRepo(tmpDir);
    const root = resolveUltraPlanRoot(paths, subdir);
    const sessionId = "up-abc";

    // Every helper must produce a descendant of the resolved UltraPlan root (or the root itself).
    for (
      const candidate of [
        getUltraplansDir(paths, subdir),
        getUltraplanIndexPath(paths, subdir),
        getUltraplanSessionDir(paths, subdir, sessionId),
        getUltraplanManifestPath(paths, subdir, sessionId),
        getUltraplanAuthoredJsonPath(paths, subdir, sessionId),
        getUltraplanAuthoredMarkdownPath(paths, subdir, sessionId),
        getUltraplanExecutionLogPath(paths, subdir, sessionId),
        getUltraplanHooksLogPath(paths, subdir, sessionId),
        getUltraplanReviewDir(paths, subdir, sessionId),
        getUltraplanStackReviewDir(paths, subdir, sessionId, "backend"),
        getUltraplanDomainReviewPath(paths, subdir, sessionId, "backend", "billing"),
        getUltraplanStackReviewPath(paths, subdir, sessionId, "backend"),
        getUltraplanRuntimeTrackerPath(paths, subdir, sessionId),
        getUltraplanMigrationRecordPath(paths, subdir, sessionId),
      ]
    ) {
      expect(candidate.startsWith(root)).toBe(true);
    }
  });
});
