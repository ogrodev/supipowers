import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendReliabilityRecord,
  loadReliabilitySummaries,
  readReliabilityRecords,
  summarizeReliabilityRecords,
} from "../../src/storage/reliability-metrics.js";
import type { ReliabilityRecord } from "../../src/types.js";

let tmpDir: string;
const paths = {
  project: (cwd: string, ...parts: string[]) => path.join(cwd, ".omp", "supipowers", ...parts),
} as any;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-relmetrics-"));
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

describe("appendReliabilityRecord + readReliabilityRecords", () => {
  test("returns empty when no events file exists", () => {
    expect(readReliabilityRecords(paths, tmpDir)).toEqual([]);
  });

  test("appends and reads back a single record", () => {
    const record = rec();
    appendReliabilityRecord(paths, tmpDir, record);
    const back = readReliabilityRecords(paths, tmpDir);
    expect(back).toEqual([record]);
  });

  test("preserves order of multiple appends", () => {
    appendReliabilityRecord(paths, tmpDir, rec({ ts: "2026-04-17T00:00:01.000Z", attempts: 1 }));
    appendReliabilityRecord(paths, tmpDir, rec({ ts: "2026-04-17T00:00:02.000Z", attempts: 2 }));
    appendReliabilityRecord(paths, tmpDir, rec({ ts: "2026-04-17T00:00:03.000Z", attempts: 3 }));
    const back = readReliabilityRecords(paths, tmpDir);
    expect(back.map((r) => r.attempts)).toEqual([1, 2, 3]);
  });

  test("skips malformed lines without aborting", () => {
    const eventsDir = path.join(tmpDir, ".omp", "supipowers", "reliability");
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(
      path.join(eventsDir, "events.jsonl"),
      [
        JSON.stringify(rec()),
        "{ broken json",
        JSON.stringify(rec({ command: "review" })),
        "",
      ].join("\n"),
    );
    const back = readReliabilityRecords(paths, tmpDir);
    expect(back.length).toBe(2);
    expect(back[0].command).toBe("plan");
    expect(back[1].command).toBe("review");
  });

  test("drops records missing required fields", () => {
    const eventsDir = path.join(tmpDir, ".omp", "supipowers", "reliability");
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(
      path.join(eventsDir, "events.jsonl"),
      [
        JSON.stringify(rec()),
        JSON.stringify({ command: "x" }), // missing fields
      ].join("\n"),
    );
    expect(readReliabilityRecords(paths, tmpDir).length).toBe(1);
  });
});

describe("summarizeReliabilityRecords", () => {
  test("empty records produce no summaries", () => {
    expect(summarizeReliabilityRecords([])).toEqual([]);
  });

  test("aggregates per-command and counts each outcome", () => {
    const summaries = summarizeReliabilityRecords([
      rec({ command: "plan", outcome: "ok", attempts: 1 }),
      rec({ command: "plan", outcome: "blocked", attempts: 3, reason: "schema" }),
      rec({ command: "plan", outcome: "ok", attempts: 2 }),
      rec({ command: "commit", outcome: "fallback", attempts: 3 }),
    ]);
    expect(summaries.length).toBe(2);

    const plan = summaries.find((s) => s.command === "plan")!;
    expect(plan.total).toBe(3);
    expect(plan.byOutcome.ok).toBe(2);
    expect(plan.byOutcome.blocked).toBe(1);
    expect(plan.avgAttempts).toBeCloseTo(2);
    expect(plan.lastRecordedAt).toBe("2026-04-17T00:00:00.000Z");

    const commit = summaries.find((s) => s.command === "commit")!;
    expect(commit.byOutcome.fallback).toBe(1);
  });

  test("summaries are sorted by command name", () => {
    const summaries = summarizeReliabilityRecords([
      rec({ command: "release" }),
      rec({ command: "commit" }),
      rec({ command: "plan" }),
    ]);
    expect(summaries.map((s) => s.command)).toEqual(["commit", "plan", "release"]);
  });

  test("lastRecordedAt is the max ts in the bucket", () => {
    const summaries = summarizeReliabilityRecords([
      rec({ command: "plan", ts: "2026-04-15T00:00:00.000Z" }),
      rec({ command: "plan", ts: "2026-04-17T00:00:00.000Z" }),
      rec({ command: "plan", ts: "2026-04-16T00:00:00.000Z" }),
    ]);
    expect(summaries[0].lastRecordedAt).toBe("2026-04-17T00:00:00.000Z");
  });
});

describe("loadReliabilitySummaries", () => {
  test("end-to-end read + summarize", () => {
    appendReliabilityRecord(paths, tmpDir, rec({ command: "plan", outcome: "ok", attempts: 1 }));
    appendReliabilityRecord(paths, tmpDir, rec({ command: "plan", outcome: "blocked", attempts: 3 }));
    const summaries = loadReliabilitySummaries(paths, tmpDir);
    expect(summaries.length).toBe(1);
    expect(summaries[0].total).toBe(2);
    expect(summaries[0].byOutcome.ok).toBe(1);
    expect(summaries[0].byOutcome.blocked).toBe(1);
  });
});
