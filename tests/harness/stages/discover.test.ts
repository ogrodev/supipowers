import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildDiscoverArtifact,
  HarnessDiscoverStage,
} from "../../../src/harness/stages/discover.js";
import { saveHarnessSession } from "../../../src/harness/storage.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { HarnessStageRunnerContext } from "../../../src/harness/stage-runner.js";

const SESSION_ID = "harness-discover-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-discover-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
  // Seed a TS file so the scanner sees a language.
  fs.writeFileSync(path.join(cwd, "src", "features", "user.ts"), "export const x = 1;\n");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(): HarnessStageRunnerContext {
  return {
    platform: { paths } as any,
    paths,
    cwd,
    sessionId: SESSION_ID,
    modelConfig: { version: "1", default: null, actions: {} },
    gateMode: "default",
    now: () => "2026-05-03T12:00:00.000Z",
  };
}

describe("buildDiscoverArtifact", () => {
  test("detects TypeScript and recommends fallow", () => {
    const artifact = buildDiscoverArtifact({
      cwd,
      sessionId: SESSION_ID,
      now: "2026-05-03T12:00:00.000Z",
    });
    expect(artifact.languages).toContain("typescript");
    expect(artifact.recommendedBackend).toBe("fallow");
    expect(artifact.languageCoverage[0].language).toBe("typescript");
  });

  test("detects existing fallow config and skips no duplicate flag", () => {
    fs.writeFileSync(path.join(cwd, ".fallowrc.json"), "{}");
    const artifact = buildDiscoverArtifact({
      cwd,
      sessionId: SESSION_ID,
      now: "2026-05-03T12:00:00.000Z",
    });
    expect(artifact.antiSlopExisting.fallowConfig).toBe(".fallowrc.json");
    // Recommendation is fallow; no duplicate flagged.
    expect(artifact.duplicates.find((d) => d.area === "anti-slop")).toBeUndefined();
  });

  test("flags duplicate when existing config conflicts with recommendation", () => {
    // Add Python files so recommendation flips to desloppify
    fs.mkdirSync(path.join(cwd, "src", "py"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "py", "a.py"), "x = 1\n");
    fs.writeFileSync(path.join(cwd, "src", "py", "b.py"), "y = 2\n");
    fs.writeFileSync(path.join(cwd, "src", "py", "c.py"), "z = 3\n");
    fs.writeFileSync(path.join(cwd, "src", "py", "d.py"), "w = 4\n");
    fs.writeFileSync(path.join(cwd, "src", "py", "e.py"), "v = 5\n");
    fs.writeFileSync(path.join(cwd, "src", "py", "f.py"), "u = 6\n");
    fs.writeFileSync(path.join(cwd, ".fallowrc.json"), "{}");

    const artifact = buildDiscoverArtifact({
      cwd,
      sessionId: SESSION_ID,
      now: "2026-05-03T12:00:00.000Z",
    });
    expect(artifact.recommendedBackend).toBe("desloppify");
    expect(artifact.duplicates.find((d) => d.area === "anti-slop")).toBeDefined();
  });

  test("detects monorepo via packages/", () => {
    fs.mkdirSync(path.join(cwd, "packages", "a"), { recursive: true });
    const artifact = buildDiscoverArtifact({
      cwd,
      sessionId: SESSION_ID,
      now: "2026-05-03T12:00:00.000Z",
    });
    expect(artifact.monorepoShape).toBe("monorepo");
  });

  test("detects GitHub Actions CI", () => {
    fs.mkdirSync(path.join(cwd, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".github", "workflows", "ci.yml"), "name: ci\n");
    const artifact = buildDiscoverArtifact({
      cwd,
      sessionId: SESSION_ID,
      now: "2026-05-03T12:00:00.000Z",
    });
    expect(artifact.ci.detected).toBe(true);
    expect(artifact.ci.provider).toBe("github-actions");
  });
});

describe("HarnessDiscoverStage", () => {
  test("isReady is always true (no upstream)", async () => {
    const stage = new HarnessDiscoverStage();
    expect(await stage.isReady(ctx())).toBe(true);
  });

  test("run produces a discover.json", async () => {
    saveHarnessSession(paths, cwd, {
      sessionId: SESSION_ID,
      projectName: "supipowers",
      startedAt: "2026-05-03T12:00:00.000Z",
      updatedAt: "2026-05-03T12:00:00.000Z",
      stage: "discover",
      stageStatus: "pending",
      gateMode: "default",
      iteration: 1,
      blocker: null,
      artifacts: {},
    });
    const stage = new HarnessDiscoverStage();
    const result = await stage.run(ctx());
    expect(result.status).toBe("completed");
    expect(result.artifactPaths).toContain("discover.json");
  });

  test("re-running is a skip when artifact exists", async () => {
    const stage = new HarnessDiscoverStage();
    await stage.run(ctx());
    const re = await stage.run(ctx());
    expect(re.status).toBe("skipped");
  });
});
