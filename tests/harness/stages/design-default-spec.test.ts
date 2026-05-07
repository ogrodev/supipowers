import { describe, expect, test } from "bun:test";

import { defaultDesignSpecFromDiscover } from "../../../src/harness/stages/design.js";
import { DEFAULT_HARNESS_HOOK_CONFIG } from "../../../src/harness/hooks/register.js";
import type { HarnessDiscoverArtifact } from "../../../src/types.js";

function makeDiscover(overrides: Partial<HarnessDiscoverArtifact> = {}): HarnessDiscoverArtifact {
  return {
    sessionId: "sess",
    recordedAt: "2026-05-04T00:00:00.000Z",
    languages: ["typescript"],
    frameworks: [],
    packageManagers: ["bun"],
    buildTools: ["tsc"],
    testTools: ["bun-test", "jest"],
    lintTools: ["eslint", "biome"],
    monorepoShape: "single-package",
    ci: { detected: false, configFiles: [] },
    ompInfra: {
      hasSupipowers: false,
      skills: [],
      reviewAgents: [],
      mcpServers: [],
      plansCount: 0,
    },
    antiSlopExisting: {
      fallowConfig: null,
      desloppifyConfig: null,
      knipConfig: null,
      jscpdConfig: null,
      dependencyCruiserConfig: null,
      eslintConfig: null,
      biomeConfig: null,
    },
    languageCoverage: [{ language: "typescript", fileCount: 100, share: 1 }],
    recommendedBackend: "fallow",
    recommendedBackendReason: "TS-only repo",
    commitConventions: { detected: false },
    duplicates: [],
    notes: [],
    ...overrides,
  };
}

describe("defaultDesignSpecFromDiscover", () => {
  test("inherits the recommended backend from discover", () => {
    const spec = defaultDesignSpecFromDiscover(
      makeDiscover({ recommendedBackend: "desloppify" }),
      "sess-1",
      "2026-05-04T12:00:00.000Z",
    );
    expect(spec.antiSlop.backend).toBe("desloppify");
  });

  test("populates session id, recordedAt, and default hooks", () => {
    const spec = defaultDesignSpecFromDiscover(
      makeDiscover(),
      "sess-2",
      "2026-05-04T12:00:00.000Z",
    );
    expect(spec.sessionId).toBe("sess-2");
    expect(spec.recordedAt).toBe("2026-05-04T12:00:00.000Z");
    expect(spec.antiSlop.hooks).toEqual(DEFAULT_HARNESS_HOOK_CONFIG);
  });

  test("picks the first lintTool and testTool from discover", () => {
    const spec = defaultDesignSpecFromDiscover(
      makeDiscover(),
      "sess-3",
      "2026-05-04T12:00:00.000Z",
    );
    expect(spec.tooling.lint).toBe("eslint");
    expect(spec.tooling.structuralTest).toBe("bun-test");
  });

  test("leaves tooling null when discover lists none", () => {
    const spec = defaultDesignSpecFromDiscover(
      makeDiscover({ lintTools: [], testTools: [] }),
      "sess-4",
      "2026-05-04T12:00:00.000Z",
    );
    expect(spec.tooling.lint).toBeNull();
    expect(spec.tooling.structuralTest).toBeNull();
  });

  test("emits the canonical docs tree and validation gate guarantees", () => {
    const spec = defaultDesignSpecFromDiscover(
      makeDiscover(),
      "sess-5",
      "2026-05-04T12:00:00.000Z",
    );
    expect(spec.docsTree).toEqual([
      "docs/architecture.md",
      "docs/golden-principles.md",
    ]);
    expect(spec.validationGates.map((gate) => gate.name)).toEqual(["lint", "typecheck", "test", "anti-slop-scan"]);
    expect(spec.validationGates.every((gate) => gate.invariant && gate.proves && gate.doesNotProve)).toBe(true);
    expect(spec.validationGates.find((gate) => gate.name === "typecheck")?.blocksOn).toContain("non-zero");
  });
});
