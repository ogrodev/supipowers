import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { writeStepSummary } from "../../../src/harness/pr-comment/workflow-summary.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-summary-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeStepSummary", () => {
  test("no-op success when GITHUB_STEP_SUMMARY is unset", () => {
    const result = writeStepSummary("hello", {});
    expect(result.ok).toBe(true);
    expect(result.path).toBeUndefined();
  });

  test("appends to the summary file with a leading blank-line separator", () => {
    const summaryPath = path.join(tmpDir, "summary.md");
    fs.writeFileSync(summaryPath, "pre-existing content");
    const result = writeStepSummary("# Harness", { GITHUB_STEP_SUMMARY: summaryPath });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(summaryPath);
    const after = fs.readFileSync(summaryPath, "utf8");
    expect(after).toBe("pre-existing content\n# Harness\n");
  });

  test("creates the summary file if it does not exist (appendFileSync semantics)", () => {
    const summaryPath = path.join(tmpDir, "fresh-summary.md");
    const result = writeStepSummary("# fresh", { GITHUB_STEP_SUMMARY: summaryPath });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(summaryPath, "utf8")).toBe("\n# fresh\n");
  });

  test("returns ok=false with a reason on IO error (directory does not exist)", () => {
    const result = writeStepSummary("hello", {
      GITHUB_STEP_SUMMARY: path.join(tmpDir, "missing-dir", "summary.md"),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
