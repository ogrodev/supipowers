import { describe, expect, test } from "bun:test";

import type {
  HarnessScore,
  HarnessScoreDimension,
  HarnessValidateCheck,
  HarnessValidateFinding,
  HarnessValidateReport,
} from "../../../src/types.js";
import { renderHarnessPrComment } from "../../../src/harness/pr-comment/render.js";
import { STICKY_MARKER_PREFIX } from "../../../src/harness/pr-comment/status.js";
import type {
  PrCommentPreviousScore,
  PrCommentTrendPoint,
  RenderInput,
} from "../../../src/harness/pr-comment/types.js";

const SESSION_ID = "01HZX7QJ7";
const GENERATED_AT = "2026-05-11T12:00:00.000Z";

function dim(
  name: HarnessScoreDimension["name"],
  strict: number,
  overrides: Partial<HarnessScoreDimension> = {},
): HarnessScoreDimension {
  return {
    name,
    lenient: strict,
    strict,
    total: 10,
    open: 0,
    resolved: 10,
    wontfix: 0,
    ...overrides,
  };
}

function score(strict: number, lenient: number, dimensions: HarnessScoreDimension[]): HarnessScore {
  return { computedAt: GENERATED_AT, lenient, strict, dimensions };
}

function check(
  name: string,
  passed: boolean,
  overrides: Partial<HarnessValidateCheck> = {},
): HarnessValidateCheck {
  return {
    name,
    passed,
    summary: passed ? "" : "something broke",
    findings: [],
    invariant: `${name} invariant`,
    proves: "proves",
    doesNotProve: "does not prove",
    artifact: "artifact",
    failSafe: "fail-safe",
    ...overrides,
  };
}

function finding(overrides: Partial<HarnessValidateFinding> = {}): HarnessValidateFinding {
  return {
    severity: "error",
    file: "src/foo.ts",
    line: 42,
    message: "Something bad",
    remediation: "Fix it",
    source: "synthetic-edit-test",
    ...overrides,
  };
}

function makeReport(overrides: Partial<HarnessValidateReport> = {}): HarnessValidateReport {
  const dims = [
    dim("duplicates", 95),
    dim("deadCode", 90),
    dim("layerViolations", 88),
    dim("other", 100),
  ];
  return {
    sessionId: SESSION_ID,
    recordedAt: GENERATED_AT,
    passed: true,
    checks: [
      check("cross-link-check", true),
      check("schema-check", true),
      check("discover-drift", true),
      check("anti-slop-scan", true),
      check("synthetic-edit-test", true),
      check("ci-local-wiring", true),
    ],
    slopScan: { backend: "fallow", duplicates: 0, deadCode: 0, layerViolations: 0, other: 0 },
    score: score(93, 95, dims),
    scoreFloorPassed: true,
    syntheticEditTest: { ran: true, hooksFired: [], failures: [] },
    ...overrides,
  };
}

function makeInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    report: makeReport(),
    previousScore: null,
    trend: [],
    scoreFloor: { strict: 75, lenient: 90 },
    sessionId: SESSION_ID,
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

describe("renderHarnessPrComment — passing report", () => {
  const input = makeInput();
  const result = renderHarnessPrComment(input);

  test("status is 'passed'", () => {
    expect(result.status).toBe("passed");
  });

  test("body starts with the marker prefix", () => {
    expect(result.body.startsWith(STICKY_MARKER_PREFIX)).toBe(true);
  });

  test("marker is the first line and is included in the body", () => {
    const firstLine = result.body.split("\n", 1)[0];
    expect(firstLine).toBe(result.marker);
    expect(result.marker).toContain("status=passed");
  });

  test("banner uses green emoji and does not say 'blocked'", () => {
    expect(result.body).toContain("🟢 Harness");
    expect(result.body).not.toContain("**blocked**");
  });

  test("score delta is 0 with no previous score", () => {
    expect(result.scoreDelta).toBe(0);
  });

  test("does NOT show a failed-checks section", () => {
    expect(result.body).not.toContain("Failed checks");
  });

  test("shows the passed-checks collapsible (not auto-expanded)", () => {
    expect(result.body).toContain("<details><summary>Passed checks (6)</summary>");
  });

  test("scorecard table is present", () => {
    expect(result.body).toContain("| Dimension | Score | Δ | Open | Resolved | Wontfix |");
    expect(result.body).toContain("| Duplicates | 95 |");
  });

  test("trend is omitted when no history is provided", () => {
    expect(result.body).not.toContain("Trend (");
    expect(result.body).not.toContain("<summary>Trend</summary>");
  });

  test("footer includes floor + session + attribution", () => {
    expect(result.body).toContain("Score floor: strict 75 / lenient 90");
    expect(result.body).toContain("`🤖 /supi:harness validate`");
  });
});

describe("renderHarnessPrComment — failed report", () => {
  const failingCheck = check("ci-local-wiring", false, {
    summary: "workflow run line does not match localCommand",
    findings: [
      finding({
        severity: "error",
        file: ".github/workflows/harness.yml",
        line: 12,
        message: "workflow runs `bun run check` but config says `bun run harness:quality`",
        source: "ci-local-wiring",
      }),
    ],
  });
  const slopFailingCheck = check("anti-slop-scan", false, {
    summary: "4 slop finding(s) recorded; see queue.",
  });

  const report = makeReport({
    passed: false,
    scoreFloorPassed: false,
    checks: [
      check("cross-link-check", true),
      check("schema-check", true),
      check("discover-drift", true),
      slopFailingCheck,
      check("synthetic-edit-test", true),
      failingCheck,
    ],
    slopScan: { backend: "fallow", duplicates: 2, deadCode: 2, layerViolations: 0, other: 0 },
    score: score(64, 71, [
      dim("duplicates", 68, { open: 7, resolved: 12, wontfix: 0 }),
      dim("deadCode", 75, { open: 12, resolved: 8, wontfix: 1 }),
      dim("layerViolations", 50, { open: 6, resolved: 2, wontfix: 0 }),
      dim("other", 100),
    ]),
  });

  const previous: PrCommentPreviousScore = { recordedAt: "2026-04-01T00:00:00Z", strict: 73, lenient: 80 };
  const result = renderHarnessPrComment(makeInput({ report, previousScore: previous, baseRef: "main@a1b2c3d" }));

  test("status is 'failed'", () => {
    expect(result.status).toBe("failed");
  });

  test("banner shows red emoji, signed negative delta, and 'blocked'", () => {
    expect(result.body).toContain("🔴 Harness");
    expect(result.body).toContain("`-9`");
    expect(result.body).toContain("**blocked**");
  });

  test("summary line mentions failed checks, new slop, score floor, base ref", () => {
    expect(result.body).toContain("2 checks failed");
    expect(result.body).toContain("4 new slop findings");
    expect(result.body).toContain("strict score below floor (75)");
    expect(result.body).toContain("Base: `main@a1b2c3d`");
  });

  test("failed-checks block is auto-expanded", () => {
    expect(result.body).toContain("<details open><summary><strong>Failed checks (2)</strong></summary>");
  });

  test("each failed check renders its invariant", () => {
    expect(result.body).toContain("**Invariant**: ci-local-wiring invariant");
    expect(result.body).toContain("**Invariant**: anti-slop-scan invariant");
  });

  test("ci-local-wiring failure renders the finding row", () => {
    expect(result.body).toContain("`.github/workflows/harness.yml:12`");
    expect(result.body).toContain("workflow runs `bun run check`");
  });

  test("anti-slop-scan failure surfaces slop counts and triage hint", () => {
    expect(result.body).toContain("| Duplicates | 2 |");
    expect(result.body).toContain("| Dead code | 2 |");
    expect(result.body).toContain("`/supi:harness next`");
  });

  test("scorecard shows per-dimension counts", () => {
    expect(result.body).toContain("| Duplicates | 68 |");
    expect(result.body).toContain("| Layer violations | 50 |");
  });
});

describe("renderHarnessPrComment — warned (score-floor breach only)", () => {
  const report = makeReport({
    passed: false,
    scoreFloorPassed: false,
    checks: [
      check("cross-link-check", true),
      check("schema-check", true),
      check("discover-drift", true),
      check("anti-slop-scan", true),
      check("synthetic-edit-test", true),
      check("ci-local-wiring", true),
    ],
    score: score(72, 88, [
      dim("duplicates", 80),
      dim("deadCode", 70),
      dim("layerViolations", 70),
      dim("other", 70),
    ]),
  });
  const result = renderHarnessPrComment(makeInput({ report }));

  test("status is 'warned'", () => {
    expect(result.status).toBe("warned");
  });

  test("banner uses yellow emoji, no 'blocked' tag", () => {
    expect(result.body).toContain("🟡 Harness");
    expect(result.body).not.toContain("**blocked**");
  });

  test("summary mentions score floor breach", () => {
    expect(result.body).toContain("strict score below floor (75)");
  });

  test("does not show a failed-checks section because every check passed", () => {
    expect(result.body).not.toContain("Failed checks");
  });
});

describe("renderHarnessPrComment — trend rendering", () => {
  const trend: PrCommentTrendPoint[] = [
    { ts: "2026-04-01T00:00:00Z", strict: 80, lenient: 88 },
    { ts: "2026-04-15T00:00:00Z", strict: 82, lenient: 89 },
    { ts: "2026-05-01T00:00:00Z", strict: 92, lenient: 95 },
  ];

  test("renders an inline arrow on a passing report (inside a collapsible)", () => {
    const result = renderHarnessPrComment(makeInput({ trend }));
    expect(result.body).toContain("<summary>Trend</summary>");
    expect(result.body).toContain("`80 → 82 → 92`");
  });

  test("renders a plain trend line on a failing report (no collapsible)", () => {
    const failed = makeReport({
      passed: false,
      checks: [check("schema-check", false)],
    });
    const result = renderHarnessPrComment(makeInput({ report: failed, trend }));
    expect(result.body).toContain("Trend (last 3 runs, strict): `80 → 82 → 92`");
    expect(result.body).not.toContain("<summary>Trend</summary>");
  });

  test("omits trend when fewer than 2 points are available", () => {
    const single: PrCommentTrendPoint[] = [{ ts: "2026-05-01T00:00:00Z", strict: 92, lenient: 95 }];
    const result = renderHarnessPrComment(makeInput({ trend: single }));
    expect(result.body).not.toContain("Trend");
  });
});

describe("renderHarnessPrComment — delta + escaping", () => {
  test("scoreDelta is the signed strict difference vs previousScore", () => {
    const previous: PrCommentPreviousScore = { recordedAt: "x", strict: 88, lenient: 90 };
    const result = renderHarnessPrComment(makeInput({ previousScore: previous }));
    expect(result.scoreDelta).toBe(93 - 88);
    expect(result.body).toContain("`+5`");
  });

  test("renders pipe-escaped messages in finding tables", () => {
    const report = makeReport({
      passed: false,
      checks: [
        check("synthetic-edit-test", false, {
          findings: [finding({ message: "weird|message|here", file: "x" })],
        }),
      ],
    });
    const result = renderHarnessPrComment(makeInput({ report }));
    expect(result.body).toContain("weird\\|message\\|here");
  });
});
