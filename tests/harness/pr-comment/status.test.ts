import { describe, expect, test } from "bun:test";

import type { HarnessValidateReport } from "../../../src/types.js";
import { deriveStatus, parseMarker, renderMarker, STICKY_MARKER_PREFIX } from "../../../src/harness/pr-comment/status.js";

function makeReport(overrides: Partial<HarnessValidateReport>): HarnessValidateReport {
  const base: HarnessValidateReport = {
    sessionId: "sess-test",
    recordedAt: "2026-05-11T12:00:00.000Z",
    passed: true,
    checks: [],
    slopScan: { backend: "fallow", duplicates: 0, deadCode: 0, layerViolations: 0, other: 0 },
    score: {
      computedAt: "2026-05-11T12:00:00.000Z",
      lenient: 100,
      strict: 100,
      dimensions: [],
    },
    scoreFloorPassed: true,
    syntheticEditTest: { ran: true, hooksFired: [], failures: [] },
  };
  return { ...base, ...overrides };
}

function makeCheck(passed: boolean) {
  return {
    name: "anti-slop-scan",
    passed,
    summary: "",
    findings: [],
    invariant: "x",
    proves: "y",
    doesNotProve: "z",
    artifact: "queue",
    failSafe: "queue stays unchanged",
  };
}

describe("deriveStatus", () => {
  test("returns 'passed' when every check passed, report.passed=true, and floor satisfied", () => {
    expect(deriveStatus(makeReport({}))).toBe("passed");
  });

  test("returns 'warned' when all checks pass but score is below floor", () => {
    const report = makeReport({
      passed: false, // overall flag set to false because floor failed
      scoreFloorPassed: false,
      checks: [makeCheck(true)],
    });
    // Even though report.passed === false, deriveStatus inspects per-check + floor; since
    // no check failed, the failure source IS the floor → warned.
    expect(deriveStatus(report)).toBe("warned");
  });

  test("returns 'failed' when at least one check failed", () => {
    const report = makeReport({
      passed: false,
      checks: [makeCheck(true), makeCheck(false)],
    });
    expect(deriveStatus(report)).toBe("failed");
  });

  test("returns 'failed' when report.passed=false even if checks array is empty", () => {
    const report = makeReport({ passed: false });
    expect(deriveStatus(report)).toBe("failed");
  });
});

describe("marker round-trip", () => {
  const FIELDS = {
    status: "passed" as const,
    strict: 92,
    lenient: 95,
    sessionId: "01HZX7QJ7",
    generatedAt: "2026-05-11T12:00:00.000Z",
  };

  test("renderMarker emits the canonical prefix and all fields", () => {
    const marker = renderMarker(FIELDS);
    expect(marker.startsWith(STICKY_MARKER_PREFIX)).toBe(true);
    expect(marker).toContain("status=passed");
    expect(marker).toContain("strict=92");
    expect(marker).toContain("lenient=95");
    expect(marker).toContain("session=01HZX7QJ7");
    expect(marker).toContain("generatedAt=2026-05-11T12:00:00.000Z");
    expect(marker.endsWith("-->")).toBe(true);
  });

  test("parseMarker round-trips renderMarker", () => {
    const marker = renderMarker(FIELDS);
    expect(parseMarker(marker)).toEqual(FIELDS);
  });

  test("parseMarker recovers from a marker followed by body content", () => {
    const body = `${renderMarker(FIELDS)}\n## body line\n\nmore content`;
    expect(parseMarker(body)).toEqual(FIELDS);
  });

  test("parseMarker rejects bodies that do not start with the prefix", () => {
    expect(parseMarker("## Just a heading")).toBeNull();
    expect(parseMarker("<!-- other:marker:v1 status=passed -->")).toBeNull();
  });

  test("parseMarker rejects malformed status values", () => {
    const body = `${STICKY_MARKER_PREFIX}status=greenish strict=10 lenient=10 session=s generatedAt=t -->`;
    expect(parseMarker(body)).toBeNull();
  });

  test("parseMarker rejects non-numeric scores", () => {
    const body = `${STICKY_MARKER_PREFIX}status=passed strict=NaN lenient=10 session=s generatedAt=t -->`;
    expect(parseMarker(body)).toBeNull();
  });

  test("renderMarker rejects whitespace in sessionId (would corrupt round-trip)", () => {
    expect(() =>
      renderMarker({ ...FIELDS, sessionId: "with space" }),
    ).toThrow(/sessionId/);
  });
});
