import { describe, expect, test } from "bun:test";

import {
  parseProvenance,
} from "../../../src/harness/docs/provenance.js";
import {
  DEFAULT_INDEX_MAX_LOC,
  renderDocsIndex,
} from "../../../src/harness/docs/index-renderer.js";
import type { HarnessLayerRule } from "../../../src/types.js";

const LAYERS: HarnessLayerRule[] = [
  { layer: "lib", globs: ["src/lib/**"], allowedImports: [], forbiddenImports: [] },
  { layer: "app", globs: ["src/app/**"], allowedImports: ["lib"], forbiddenImports: [] },
];

describe("renderDocsIndex", () => {
  test("includes provenance marker, headings, and table rows", () => {
    const out = renderDocsIndex({
      layers: LAYERS,
      sessionId: "harness-x-1",
      generatedAt: "2026-05-12T12:00:00.000Z",
    });
    expect(out.startsWith("<!-- harness-docs:")).toBe(true);
    expect(out).toContain("# Repo docs");
    expect(out).toContain("## Agent contract");
    expect(out).toContain("## Layer docs");
    expect(out).toContain("docs/layers/lib.md");
    expect(out).toContain("docs/layers/app.md");
    expect(out).toContain("`src/lib/**`");
  });

  test("output sorts layers by id", () => {
    const out = renderDocsIndex({
      layers: LAYERS,
      sessionId: "x",
      generatedAt: "2026-05-12T00:00:00.000Z",
    });
    const appIdx = out.indexOf("docs/layers/app.md");
    const libIdx = out.indexOf("docs/layers/lib.md");
    expect(appIdx).toBeGreaterThan(0);
    expect(libIdx).toBeGreaterThan(0);
    expect(appIdx).toBeLessThan(libIdx);
  });

  test("renders deterministically across calls", () => {
    const args = {
      layers: LAYERS,
      sessionId: "harness-x",
      generatedAt: "2026-05-12T12:00:00.000Z",
    };
    expect(renderDocsIndex(args)).toBe(renderDocsIndex(args));
  });

  test("provenance marker round-trips", () => {
    const out = renderDocsIndex({
      layers: LAYERS,
      sessionId: "harness-x",
      generatedAt: "2026-05-12T12:00:00.000Z",
    });
    const parsed = parseProvenance(out);
    expect(parsed).not.toBeNull();
    expect(parsed?.provenance.sessionId).toBe("harness-x");
  });

  test("rejects empty layer list", () => {
    expect(() =>
      renderDocsIndex({ layers: [], sessionId: "x", generatedAt: "2026-05-12" }),
    ).toThrow(/at least one layer/);
  });

  test("stays under the default LOC cap for 2 layers", () => {
    const out = renderDocsIndex({
      layers: LAYERS,
      sessionId: "harness-x",
      generatedAt: "2026-05-12T12:00:00.000Z",
    });
    const lineCount = out.split("\n").filter((_, i, arr) => i < arr.length - 1).length;
    expect(lineCount).toBeLessThanOrEqual(DEFAULT_INDEX_MAX_LOC);
  });
});
