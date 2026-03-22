import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateRunId,
  createRun,
  loadRun,
  updateRun,
  saveAgentResult,
  loadAgentResult,
  loadAllAgentResults,
  findActiveRun,
} from "../../src/storage/runs.js";
import type { RunManifest, AgentResult } from "../../src/types.js";
import { createPaths } from "../../src/platform/types.js";

const paths = createPaths(".omp");

describe("runs storage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("generateRunId returns expected format", () => {
    const id = generateRunId();
    expect(id).toMatch(/^run-\d{8}-\d{6}-[a-z0-9]{4}$/);
  });

  test("generateRunId produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateRunId()));
    expect(ids.size).toBe(10);
  });

  test("createRun and loadRun roundtrip", () => {
    const manifest: RunManifest = {
      id: "run-20260310-143052",
      planRef: "test-plan.md",
      profile: "thorough",
      status: "running",
      startedAt: new Date().toISOString(),
      batches: [{ index: 0, taskIds: [1, 2], status: "pending" }],
    };
    createRun(paths, tmpDir, manifest);
    const loaded = loadRun(paths, tmpDir, manifest.id);
    expect(loaded).toEqual(manifest);
  });

  test("updateRun persists changes", () => {
    const manifest: RunManifest = {
      id: "run-20260310-143052",
      planRef: "test.md",
      profile: "quick",
      status: "running",
      startedAt: new Date().toISOString(),
      batches: [{ index: 0, taskIds: [1], status: "pending" }],
    };
    createRun(paths, tmpDir, manifest);
    manifest.status = "completed";
    updateRun(paths, tmpDir, manifest);
    expect(loadRun(paths, tmpDir, manifest.id)?.status).toBe("completed");
  });

  test("agent results roundtrip", () => {
    const manifest: RunManifest = {
      id: "run-test",
      planRef: "test.md",
      profile: "quick",
      status: "running",
      startedAt: new Date().toISOString(),
      batches: [],
    };
    createRun(paths, tmpDir, manifest);

    const result: AgentResult = {
      taskId: 1,
      status: "done",
      output: "implemented feature",
      filesChanged: ["src/foo.ts"],
      duration: 5000,
    };
    saveAgentResult(paths, tmpDir, "run-test", result);
    expect(loadAgentResult(paths, tmpDir, "run-test", 1)).toEqual(result);
    expect(loadAllAgentResults(paths, tmpDir, "run-test")).toHaveLength(1);
  });

  test("findActiveRun returns running run", () => {
    const manifest: RunManifest = {
      id: "run-active",
      planRef: "test.md",
      profile: "quick",
      status: "running",
      startedAt: new Date().toISOString(),
      batches: [],
    };
    createRun(paths, tmpDir, manifest);
    expect(findActiveRun(paths, tmpDir)?.id).toBe("run-active");
  });

  test("findActiveRun returns null when no active runs", () => {
    expect(findActiveRun(paths, tmpDir)).toBeNull();
  });
});
