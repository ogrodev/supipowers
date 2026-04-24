import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getUltraplanActiveBatchRunPath,
  getUltraplanAuthoredJsonPath,
  getUltraplanAuthoredMarkdownPath,
  getUltraplanBatchJournalPath,
  getUltraplanBatchRunDir,
  getUltraplanBatchRunPath,
  getUltraplanBatchRunsDir,
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
import { projectSlugFromRepoRoot } from "../../src/workspace/project-slug.js";
import { createTestPaths, createTestRepo } from "./fixtures.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-paths-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedPrimaryGitDir(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
}

function createLinkedWorktree(repoRoot: string, worktreeName: string, rootDir: string): { worktreeRoot: string; subdir: string } {
  seedPrimaryGitDir(repoRoot);
  const worktreeRoot = path.join(rootDir, worktreeName);
  const subdir = path.join(worktreeRoot, "src", "features");
  const worktreeGitDir = path.join(repoRoot, ".git", "worktrees", worktreeName);
  fs.mkdirSync(subdir, { recursive: true });
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeRoot, "package.json"), JSON.stringify({ name: path.basename(repoRoot) }), "utf8");
  fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
  fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
  return { worktreeRoot, subdir };
}

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

  test("builds centralized batch-run paths under the canonical ultraplan root", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot, subdir } = createTestRepo(tmpDir);
    const slug = projectSlugFromRepoRoot(repoRoot);
    const runId = "batch-123";
    const batchRunsDir = paths.global("projects", slug, "ultraplans", "batch-runs");
    const batchRunDir = path.join(batchRunsDir, runId);

    expect(getUltraplanBatchRunsDir(paths, subdir)).toBe(batchRunsDir);
    expect(getUltraplanActiveBatchRunPath(paths, subdir)).toBe(
      path.join(batchRunsDir, "active-run.json"),
    );
    expect(getUltraplanBatchRunDir(paths, subdir, runId)).toBe(batchRunDir);
    expect(getUltraplanBatchRunPath(paths, subdir, runId)).toBe(
      path.join(batchRunDir, "run.json"),
    );
    expect(getUltraplanBatchJournalPath(paths, subdir, runId)).toBe(
      path.join(batchRunDir, "journal.jsonl"),
    );
  });

  test("shares one canonical project dir across the primary checkout and linked worktrees", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot, subdir } = createTestRepo(tmpDir, "primary-repo");
    const { worktreeRoot, subdir: worktreeSubdir } = createLinkedWorktree(repoRoot, "feature-worktree", tmpDir);
    const expectedProjectDir = getUltraplanProjectDir(paths, repoRoot);

    expect(getUltraplanProjectDir(paths, subdir)).toBe(expectedProjectDir);
    expect(getUltraplanProjectDir(paths, worktreeRoot)).toBe(expectedProjectDir);
    expect(getUltraplanProjectDir(paths, worktreeSubdir)).toBe(expectedProjectDir);
    expect(resolveUltraPlanRoot(paths, worktreeSubdir)).toBe(resolveUltraPlanRoot(paths, repoRoot));
  });
});
