import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanAuthoredMarkdownPath,
  getUltraplanDomainReviewPath,
  getUltraplanIndexPath,
  getUltraplanManifestPath,
  getUltraplanProjectDir,
  getUltraplanProjectName,
  getUltraplanSessionDir,
  getUltraplanStackReviewPath,
  getUltraplansDir,
} from "../../src/ultraplan/project-paths.js";
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

  test("stores ultraplan directories under project-scoped storage rooted at the repo", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot, subdir } = createTestRepo(tmpDir);

    expect(getUltraplanProjectDir(paths, repoRoot)).toBe(paths.project(repoRoot));
    expect(getUltraplanProjectDir(paths, subdir)).toBe(paths.project(repoRoot));
    expect(getUltraplansDir(paths, subdir)).toBe(paths.project(repoRoot, "ultraplans"));
    expect(getUltraplanIndexPath(paths, subdir)).toBe(paths.project(repoRoot, "ultraplans", "index.json"));
  });

  test("builds exact session artifact paths from the resolved repo root", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot, subdir } = createTestRepo(tmpDir);
    const sessionId = "up-123";

    expect(getUltraplanSessionDir(paths, subdir, sessionId)).toBe(
      path.join(paths.project(repoRoot, "ultraplans"), sessionId),
    );
    expect(getUltraplanManifestPath(paths, subdir, sessionId)).toBe(
      path.join(paths.project(repoRoot, "ultraplans"), sessionId, "manifest.json"),
    );
    expect(getUltraplanAuthoredJsonPath(paths, subdir, sessionId)).toBe(
      path.join(paths.project(repoRoot, "ultraplans"), sessionId, "authored.json"),
    );
    expect(getUltraplanAuthoredMarkdownPath(paths, subdir, sessionId)).toBe(
      path.join(paths.project(repoRoot, "ultraplans"), sessionId, "authored.md"),
    );
    expect(getUltraplanDomainReviewPath(paths, subdir, sessionId, "frontend", "auth")).toBe(
      path.join(paths.project(repoRoot, "ultraplans"), sessionId, "review", "frontend", "domains", "auth.json"),
    );
    expect(getUltraplanStackReviewPath(paths, subdir, sessionId, "frontend")).toBe(
      path.join(paths.project(repoRoot, "ultraplans"), sessionId, "review", "frontend", "stack.json"),
    );
  });
});
