import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadBaseline } from "../../../src/harness/pr-comment/baseline.js";
import { appendScoreHistory } from "../../../src/harness/storage.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-pr-baseline-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seed(record: { ts: string; sessionId: string; strict: number; lenient: number }) {
  appendScoreHistory(paths, cwd, {
    recordedAt: record.ts,
    sessionId: record.sessionId,
    strict: record.strict,
    lenient: record.lenient,
  });
}

describe("loadBaseline", () => {
  test("returns empty baseline when no history exists", () => {
    const baseline = loadBaseline(paths, cwd, { currentSessionId: "s-1" });
    expect(baseline.previousScore).toBeNull();
    expect(baseline.trend).toEqual([]);
  });

  test("returns previous=null when only the current session's record is present", () => {
    seed({ ts: "2026-05-01T00:00:00Z", sessionId: "s-now", strict: 80, lenient: 90 });
    const baseline = loadBaseline(paths, cwd, { currentSessionId: "s-now" });
    expect(baseline.previousScore).toBeNull();
    // Trend still includes the current run so the sparkline ends on the just-computed score.
    expect(baseline.trend).toEqual([
      { ts: "2026-05-01T00:00:00Z", strict: 80, lenient: 90 },
    ]);
  });

  test("returns the most recent prior entry as previousScore", () => {
    seed({ ts: "2026-04-01T00:00:00Z", sessionId: "s-old", strict: 70, lenient: 80 });
    seed({ ts: "2026-05-01T00:00:00Z", sessionId: "s-now", strict: 80, lenient: 90 });
    const baseline = loadBaseline(paths, cwd, { currentSessionId: "s-now" });
    expect(baseline.previousScore).toEqual({
      recordedAt: "2026-04-01T00:00:00Z",
      strict: 70,
      lenient: 80,
    });
  });

  test("skips multiple trailing records that share the current session id", () => {
    // Validate may be re-run within the same session (interactive iteration), producing
    // several history entries for the same id. Baseline should hop over all of them.
    seed({ ts: "2026-04-01T00:00:00Z", sessionId: "s-prev", strict: 60, lenient: 70 });
    seed({ ts: "2026-04-15T00:00:00Z", sessionId: "s-now", strict: 75, lenient: 85 });
    seed({ ts: "2026-05-01T00:00:00Z", sessionId: "s-now", strict: 80, lenient: 90 });
    const baseline = loadBaseline(paths, cwd, { currentSessionId: "s-now" });
    expect(baseline.previousScore?.recordedAt).toBe("2026-04-01T00:00:00Z");
    expect(baseline.previousScore?.strict).toBe(60);
  });

  test("trend is the last N records oldest-first (default 5)", () => {
    const records = [
      { ts: "2026-01-01T00:00:00Z", sessionId: "s1", strict: 50, lenient: 60 },
      { ts: "2026-02-01T00:00:00Z", sessionId: "s2", strict: 60, lenient: 70 },
      { ts: "2026-03-01T00:00:00Z", sessionId: "s3", strict: 70, lenient: 80 },
      { ts: "2026-04-01T00:00:00Z", sessionId: "s4", strict: 75, lenient: 85 },
      { ts: "2026-05-01T00:00:00Z", sessionId: "s5", strict: 80, lenient: 90 },
      { ts: "2026-06-01T00:00:00Z", sessionId: "s6", strict: 85, lenient: 92 },
    ];
    for (const r of records) seed(r);
    const baseline = loadBaseline(paths, cwd, { currentSessionId: "s6" });
    expect(baseline.trend.map((t) => t.strict)).toEqual([60, 70, 75, 80, 85]);
  });

  test("respects custom trend limit", () => {
    for (let i = 1; i <= 10; i += 1) {
      seed({ ts: `2026-${String(i).padStart(2, "0")}-01T00:00:00Z`, sessionId: `s${i}`, strict: i * 10, lenient: i * 10 });
    }
    const baseline = loadBaseline(paths, cwd, { currentSessionId: "s10", limit: 3 });
    expect(baseline.trend.length).toBe(3);
    expect(baseline.trend.map((t) => t.strict)).toEqual([80, 90, 100]);
  });

  test("ignores malformed records and continues", () => {
    seed({ ts: "2026-04-01T00:00:00Z", sessionId: "s-prev", strict: 70, lenient: 80 });
    // Inject a malformed line directly.
    const historyPath = path.join(
      tmpDir,
      "global-config", ".omp", "supipowers", "projects",
    );
    // Find the slug dir — there's exactly one since we used a single test repo.
    const slugDir = fs.readdirSync(historyPath)[0];
    const filePath = path.join(historyPath, slugDir, "harness", "score-history.jsonl");
    fs.appendFileSync(filePath, `{"oops": true, "no_required_fields": "yep"}\n`);
    seed({ ts: "2026-05-01T00:00:00Z", sessionId: "s-now", strict: 80, lenient: 90 });
    const baseline = loadBaseline(paths, cwd, { currentSessionId: "s-now" });
    expect(baseline.previousScore?.strict).toBe(70);
  });
});
