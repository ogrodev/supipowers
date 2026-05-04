import { describe, expect, test } from "bun:test";

import { recommendBackend } from "../../../src/harness/anti_slop/recommend.js";

describe("recommendBackend", () => {
  test("TS-only repo → fallow", () => {
    const r = recommendBackend({
      languageCoverage: [{ language: "typescript", fileCount: 100, share: 1 }],
    });
    expect(r.backend).toBe("fallow");
  });

  test("TS+JS repo → fallow", () => {
    const r = recommendBackend({
      languageCoverage: [
        { language: "typescript", fileCount: 80, share: 0.8 },
        { language: "javascript", fileCount: 20, share: 0.2 },
      ],
    });
    expect(r.backend).toBe("fallow");
  });

  test("polyglot ≥3 languages → desloppify", () => {
    const r = recommendBackend({
      languageCoverage: [
        { language: "typescript", fileCount: 50, share: 0.5 },
        { language: "python", fileCount: 30, share: 0.3 },
        { language: "rust", fileCount: 20, share: 0.2 },
      ],
    });
    expect(r.backend).toBe("desloppify");
    expect(r.reason).toContain("polyglot");
  });

  test("Python present → desloppify", () => {
    const r = recommendBackend({
      languageCoverage: [
        { language: "typescript", fileCount: 40, share: 0.4 },
        { language: "python", fileCount: 60, share: 0.6 },
      ],
    });
    expect(r.backend).toBe("desloppify");
  });

  test("TS-dominant with subtree → hybrid", () => {
    const r = recommendBackend({
      languageCoverage: [
        { language: "typescript", fileCount: 80, share: 0.8 },
        { language: "shell", fileCount: 20, share: 0.2 },
      ],
    });
    expect(r.backend).toBe("hybrid");
  });

  test("empty input → supi-native", () => {
    const r = recommendBackend({ languageCoverage: [] });
    expect(r.backend).toBe("supi-native");
  });
});
