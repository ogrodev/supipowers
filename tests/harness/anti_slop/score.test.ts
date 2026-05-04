import { describe, expect, test } from "bun:test";

import {
  computeScore,
  renderScoreBadge,
  scoreFloorPassed,
} from "../../../src/harness/anti_slop/score.js";
import type { HarnessSlopQueueEntry } from "../../../src/types.js";

function entry(overrides: Partial<HarnessSlopQueueEntry>): HarnessSlopQueueEntry {
  return {
    id: "x",
    kind: "duplicate",
    file: "src/foo.ts",
    range: null,
    severity: "warning",
    source: "fallow",
    state: "open",
    message: "msg",
    ts: "2026-05-03T12:00:00.000Z",
    ...overrides,
  };
}

describe("computeScore", () => {
  test("empty queue → 100/100 in every dimension", () => {
    const score = computeScore({ computedAt: "2026-05-03T12:00:00.000Z", entries: [] });
    expect(score.lenient).toBe(100);
    expect(score.strict).toBe(100);
    for (const dim of score.dimensions) {
      expect(dim.lenient).toBe(100);
      expect(dim.strict).toBe(100);
      expect(dim.total).toBe(0);
    }
  });

  test("lenient ignores wontfix; strict counts it", () => {
    const score = computeScore({
      computedAt: "2026-05-03T12:00:00.000Z",
      entries: [
        entry({ id: "a", kind: "duplicate", state: "wontfix" }),
        entry({ id: "b", kind: "duplicate", state: "resolved" }),
      ],
    });
    const dupes = score.dimensions.find((d) => d.name === "duplicates");
    expect(dupes?.total).toBe(2);
    expect(dupes?.wontfix).toBe(1);
    expect(dupes?.resolved).toBe(1);
    // Lenient: cost = open = 0 → 100
    expect(dupes?.lenient).toBe(100);
    // Strict: cost = open + wontfix = 1; total = 2 → 100*(1 - 1/2) = 50
    expect(dupes?.strict).toBe(50);
  });

  test("dimension boundaries: open dominates score", () => {
    const score = computeScore({
      computedAt: "2026-05-03T12:00:00.000Z",
      entries: [entry({ id: "x", kind: "dead-code", state: "open" })],
    });
    const dead = score.dimensions.find((d) => d.name === "deadCode");
    expect(dead?.total).toBe(1);
    expect(dead?.open).toBe(1);
    expect(dead?.lenient).toBe(0);
    expect(dead?.strict).toBe(0);
  });

  test("scoreFloorPassed accepts when both scores meet the floor", () => {
    const score = computeScore({ computedAt: "2026-05-03T12:00:00.000Z", entries: [] });
    const result = scoreFloorPassed(score, { strict: 75, lenient: 90 });
    expect(result.passed).toBe(true);
  });

  test("scoreFloorPassed rejects when strict floor missed", () => {
    const score = computeScore({
      computedAt: "2026-05-03T12:00:00.000Z",
      entries: [
        entry({ id: "1", kind: "duplicate", state: "open" }),
        entry({ id: "2", kind: "dead-code", state: "open" }),
        entry({ id: "3", kind: "layer-violation", state: "open" }),
        entry({ id: "4", kind: "other", state: "open" }),
      ],
    });
    const result = scoreFloorPassed(score, { strict: 75, lenient: 90 });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("strict");
  });
});

describe("renderScoreBadge", () => {
  test("emits SVG with the strict score and a color tier", () => {
    const score = computeScore({ computedAt: "2026-05-03T12:00:00.000Z", entries: [] });
    const badge = renderScoreBadge(score);
    expect(badge.startsWith("<svg")).toBe(true);
    expect(badge).toContain("harness 100");
    expect(badge).toContain("#3fb950");
  });

  test("color tier shifts with strict score", () => {
    const low = computeScore({
      computedAt: "2026-05-03T12:00:00.000Z",
      entries: [
        entry({ id: "1", kind: "duplicate", state: "open" }),
        entry({ id: "2", kind: "dead-code", state: "open" }),
      ],
    });
    const badge = renderScoreBadge(low);
    expect(badge).toContain("#cf222e");
  });
});
