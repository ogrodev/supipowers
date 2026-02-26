import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createQaRunWorkspace,
  ensureQaStorageGitignored,
  loadQaAuthProfile,
  saveQaAuthProfile,
} from "../../src/qa/storage";

describe("qa storage", () => {
  test("creates run workspace paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supipowers-qa-storage-"));
    const run = createQaRunWorkspace(cwd, "qa-test");

    expect(run.runId).toBe("qa-test");
    expect(existsSync(run.screenshotsDir)).toBe(true);
    expect(run.matrixPathRelative).toContain("qa-runs/qa-test/matrix.json");
  });

  test("persists and loads auth profile", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supipowers-qa-auth-"));
    saveQaAuthProfile(cwd, {
      targetUrl: "http://localhost:3000",
      authSetupCommands: ["goto http://localhost:3000/login"],
      updatedAt: Date.now(),
    });

    const loaded = loadQaAuthProfile(cwd);
    expect(loaded?.targetUrl).toBe("http://localhost:3000");
    expect(loaded?.authSetupCommands).toHaveLength(1);
  });

  test("ensures .pi is gitignored", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supipowers-qa-gitignore-"));
    const gitignore = join(cwd, ".gitignore");
    writeFileSync(gitignore, "node_modules/\n", "utf-8");

    const result = ensureQaStorageGitignored(cwd);
    expect(result.updated).toBe(true);
    const content = readFileSync(gitignore, "utf-8");
    expect(content).toContain(".pi/");
  });
});
