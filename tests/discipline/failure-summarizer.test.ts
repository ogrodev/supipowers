import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatFailureSummary,
  summarizeFailures,
  summarizeLocalFailures,
} from "../../src/discipline/failure-summarizer.js";
import { appendReliabilityRecord } from "../../src/storage/reliability-metrics.js";
import type { ReliabilityRecord } from "../../src/types.js";

let tmpDir: string;
const paths = {
  project: (cwd: string, ...parts: string[]) => path.join(cwd, ".omp", "supipowers", ...parts),
} as any;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-failsum-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function rec(over: Partial<ReliabilityRecord> = {}): ReliabilityRecord {
  return {
    ts: "2026-04-17T00:00:00.000Z",
    command: "plan",
    outcome: "ok",
    attempts: 1,
    ...over,
  };
}

describe("summarizeFailures — pure aggregation", () => {
  test("empty input yields empty summary", () => {
    const summary = summarizeFailures([]);
    expect(summary.totalFailures).toBe(0);
    expect(summary.aggregates).toEqual([]);
    expect(summary.unclassified).toEqual([]);
  });

  test("ok records are excluded", () => {
    const summary = summarizeFailures([rec({ outcome: "ok" }), rec({ outcome: "ok" })]);
    expect(summary.totalFailures).toBe(0);
  });

  test("classifies retry-exhausted with enough attempts as unproductive-retry", () => {
    const summary = summarizeFailures([
      rec({ command: "plan", outcome: "retry-exhausted", attempts: 3, reason: "schema mismatch" }),
      rec({ command: "plan", outcome: "retry-exhausted", attempts: 3, reason: "schema mismatch" }),
    ]);
    expect(summary.totalFailures).toBe(2);
    const agg = summary.aggregates.find((a) => a.class === "unproductive-retry");
    expect(agg).toBeDefined();
    expect(agg?.count).toBe(2);
    expect(agg?.byCommand).toEqual([{ command: "plan", count: 2 }]);
  });

  test("classifies wrong-tool-path via reason mentioning ctx_*", () => {
    const summary = summarizeFailures([
      rec({ outcome: "blocked", reason: "Use ctx_search instead of grep" }),
    ]);
    const agg = summary.aggregates.find((a) => a.class === "wrong-tool-path");
    expect(agg?.count).toBe(1);
  });

  test("unclassified bucket captures records without matching classes", () => {
    const summary = summarizeFailures([
      rec({ outcome: "blocked", reason: "something no rule matches" }),
    ]);
    expect(summary.aggregates.length).toBe(0);
    expect(summary.unclassified.length).toBe(1);
  });

  test("byCommand counts aggregate per command deterministically", () => {
    const summary = summarizeFailures([
      rec({ command: "plan", outcome: "retry-exhausted", attempts: 3, reason: "x" }),
      rec({ command: "commit", outcome: "retry-exhausted", attempts: 3, reason: "x" }),
      rec({ command: "plan", outcome: "retry-exhausted", attempts: 3, reason: "x" }),
      rec({ command: "commit", outcome: "retry-exhausted", attempts: 3, reason: "x" }),
      rec({ command: "plan", outcome: "retry-exhausted", attempts: 3, reason: "x" }),
    ]);
    const agg = summary.aggregates.find((a) => a.class === "unproductive-retry")!;
    expect(agg.byCommand).toEqual([
      { command: "commit", count: 2 },
      { command: "plan", count: 3 },
    ]);
  });

  test("examples limited by exampleCount", () => {
    const records: ReliabilityRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(rec({ outcome: "retry-exhausted", attempts: 3, reason: "x" }));
    }
    const summary = summarizeFailures(records, { exampleCount: 2 });
    const agg = summary.aggregates[0];
    expect(agg.count).toBe(10);
    expect(agg.examples.length).toBe(2);
  });

  test("aggregates sorted by taxonomy order (FAILURE_CLASSES)", () => {
    const summary = summarizeFailures([
      rec({ outcome: "retry-exhausted", attempts: 3, reason: "x" }), // unproductive-retry
      rec({ outcome: "blocked", reason: "Use ctx_search" }), // wrong-tool-path
    ]);
    const ordered = summary.aggregates.map((a) => a.class);
    // wrong-tool-path is earlier in taxonomy than unproductive-retry.
    const wtp = ordered.indexOf("wrong-tool-path");
    const ur = ordered.indexOf("unproductive-retry");
    expect(wtp).toBeLessThan(ur);
  });
});

describe("summarizeLocalFailures — filesystem path", () => {
  test("empty store produces empty summary", () => {
    expect(summarizeLocalFailures(paths, tmpDir).totalFailures).toBe(0);
  });

  test("reads and aggregates stored records", () => {
    appendReliabilityRecord(paths, tmpDir, rec({ command: "plan", outcome: "retry-exhausted", attempts: 3, reason: "schema" }));
    appendReliabilityRecord(paths, tmpDir, rec({ command: "plan", outcome: "ok" }));
    const summary = summarizeLocalFailures(paths, tmpDir);
    expect(summary.totalFailures).toBe(1);
    expect(summary.aggregates[0].class).toBe("unproductive-retry");
  });
});

describe("formatFailureSummary", () => {
  test("empty summary renders as empty lines", () => {
    expect(formatFailureSummary({ totalFailures: 0, aggregates: [], unclassified: [] })).toEqual([]);
  });

  test("header line shows total failures and per-class block follows", () => {
    const summary = summarizeFailures([
      rec({ command: "plan", outcome: "retry-exhausted", attempts: 3, reason: "x" }),
      rec({ command: "commit", outcome: "retry-exhausted", attempts: 3, reason: "x" }),
    ]);
    const lines = formatFailureSummary(summary);
    expect(lines[0]).toContain("2 non-ok record");
    expect(lines.some((l) => l.includes("[unproductive-retry]"))).toBe(true);
    expect(lines.some((l) => l.includes("commit: 1"))).toBe(true);
    expect(lines.some((l) => l.includes("plan: 1"))).toBe(true);
  });

  test("unclassified block renders when any record escapes the taxonomy", () => {
    const summary = summarizeFailures([
      rec({ outcome: "blocked", reason: "nothing matches" }),
    ]);
    const lines = formatFailureSummary(summary);
    expect(lines.some((l) => l.includes("[unclassified]"))).toBe(true);
  });
});
