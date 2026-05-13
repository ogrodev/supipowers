import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  HarnessDesignStage,
  renderDesignSpec,
  validateDesignSpec,
} from "../../../src/harness/stages/design.js";
import {
  loadHarnessDesignSpec,
  loadHarnessDesignSpecJson,
  saveHarnessDiscover,
} from "../../../src/harness/storage.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { HarnessDesignSpec, HarnessDiscoverArtifact } from "../../../src/types.js";
import type { HarnessStageRunnerContext } from "../../../src/harness/stage-runner.js";

const SESSION_ID = "harness-design-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-design-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
  saveHarnessDiscover(paths, cwd, SESSION_ID, makeDiscover());
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDiscover(): HarnessDiscoverArtifact {
  return {
    sessionId: SESSION_ID,
    recordedAt: "2026-05-03T12:00:00.000Z",
    languages: ["typescript"],
    frameworks: [],
    packageManagers: ["bun"],
    buildTools: [],
    testTools: [],
    lintTools: [],
    monorepoShape: "single-package",
    ci: { detected: false, configFiles: [] },
    ompInfra: { hasSupipowers: false, skills: [], reviewAgents: [], plansCount: 0 },
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
    recommendedBackendReason: "TS-only",
    commitConventions: { detected: false },
    duplicates: [],
    notes: [],
  };
}

function makeGate(overrides: Partial<HarnessDesignSpec["validationGates"][number]> = {}): HarnessDesignSpec["validationGates"][number] {
  return {
    name: "typecheck",
    invariant: "TypeScript contracts must compile before the harness claims the repo is safe to edit.",
    command: "bun run typecheck",
    proves: "The configured TypeScript program accepts the current source and declarations.",
    doesNotProve: "Runtime data shapes, user workflows, and dependency behavior are not exercised.",
    runsAt: "local command and CI",
    blocksOn: "non-zero exit code",
    artifact: "terminal output",
    failSafe: "If the command is missing, the gate fails and the design must name a replacement proof.",
    ...overrides,
  };
}

function makeSpec(overrides: Partial<HarnessDesignSpec> = {}): HarnessDesignSpec {
  return {
    sessionId: SESSION_ID,
    recordedAt: "2026-05-03T12:00:00.000Z",
    layerRules: [],
    tasteInvariants: ["No global state"],
    tooling: { lint: "eslint", structuralTest: null, eval: null },
    goldenPrinciples: ["No emojis in output", "Tests over docs"],
    docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
    validationGates: [makeGate()],
    ci: {
      provider: "github-actions",
      trigger: { mode: "branches", branches: ["dev", "main"] },
      localCommand: "bun run harness:quality",
      workflowPath: ".github/workflows/harness-quality.yml",
    },
    supipowersWiring: { addReviewAgent: true, wireChecksGate: false },
    antiSlop: {
      backend: "fallow",
      hooks: {
        pre_edit_dupe_probe: { enabled: true, threshold: 0.85, min_token_count: 30 },
        post_session_sweep: { enabled: true, block_on_new_dead_code: false },
        layer_context_inject: { enabled: true, addendum_max_chars: 800 },
        score_floor: { strict: 75, lenient: 90, release_blocking: false },
      },
      skillTargets: ["claude"],
    },
    ...overrides,
  };
}

function ctx(): HarnessStageRunnerContext {
  return {
    platform: { paths } as any,
    paths,
    cwd,
    sessionId: SESSION_ID,
    modelConfig: { version: "1", default: null, actions: {} },
    gateMode: "default",
    now: () => "2026-05-03T12:00:00.000Z",
  };
}

describe("renderDesignSpec", () => {
  test("emits all 9 sections", () => {
    const md = renderDesignSpec(makeSpec());
    expect(md).toContain("## 1. Layered architecture");
    expect(md).toContain("## 2. Taste invariants");
    expect(md).toContain("## 3. Tooling choices");
    expect(md).toContain("## 4. Golden principles");
    expect(md).toContain("## 5. Documentation tree");
    expect(md).toContain("## 6. Validation gates");
    expect(md).toContain("## 7. CI and local quality command");
    expect(md).toContain("## 8. Supipowers wiring");
    expect(md).toContain("## 9. Anti-slop guardrails");
  });

  test("renders backend and hook config in section 9", () => {
    const md = renderDesignSpec(makeSpec());
    expect(md).toContain("Backend: `fallow`");
    expect(md).toContain("Pre-edit dupe probe: enabled");
    expect(md).toContain("strict ≥75");
  });

  test("renders validation gates as named guarantees with blind spots", () => {
    const md = renderDesignSpec(makeSpec());
    expect(md).toContain("| Gate | Invariant | Command | Proves | Does not prove | Runs at | Blocks on | Artifact | Fail-safe |");
    expect(md).toContain("TypeScript contracts must compile");
    expect(md).toContain("Runtime data shapes");
  });

  test("renders CI and local quality command wiring", () => {
    const md = renderDesignSpec(makeSpec());
    expect(md).toContain("PRs targeting dev, main");
    expect(md).toContain("`bun run harness:quality`");
  });
});

describe("validateDesignSpec", () => {
  test("accepts a valid spec", () => {
    expect(validateDesignSpec(makeSpec())).toEqual([]);
  });

  test("rejects unknown backend", () => {
    const errors = validateDesignSpec(makeSpec({ antiSlop: { ...makeSpec().antiSlop, backend: "bogus" as never } }));
    expect(errors.find((e) => e.includes("backend"))).toBeDefined();
  });

  test("rejects out-of-range threshold", () => {
    const spec = makeSpec();
    spec.antiSlop.hooks.pre_edit_dupe_probe.threshold = 1.5;
    const errors = validateDesignSpec(spec);
    expect(errors.find((e) => e.includes("threshold"))).toBeDefined();
  });

  test("rejects gates that do not name their blind spot", () => {
    const badGate = makeGate({ doesNotProve: "" });
    const errors = validateDesignSpec(makeSpec({ validationGates: [badGate] }));
    expect(errors.find((e) => e.includes("doesNotProve"))).toBeDefined();
  });
});

describe("HarnessDesignStage", () => {
  test("persists a design spec markdown and returns awaiting-user", async () => {
    const stage = new HarnessDesignStage({ spec: makeSpec() });
    const result = await stage.run(ctx());
    expect(result.status).toBe("awaiting-user");
    const loaded = loadHarnessDesignSpec(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
  });

  test("persists a structured design-spec.json next to the markdown", async () => {
    const spec = makeSpec();
    const stage = new HarnessDesignStage({ spec });
    const result = await stage.run(ctx());
    expect(result.status).toBe("awaiting-user");
    expect(result.artifactPaths).toEqual(["design-spec.md", "design-spec.json"]);
    const loadedJson = loadHarnessDesignSpecJson(paths, cwd, SESSION_ID);
    expect(loadedJson.ok).toBe(true);
    if (loadedJson.ok) {
      expect(loadedJson.value.antiSlop.backend).toBe(spec.antiSlop.backend);
      expect(loadedJson.value.sessionId).toBe(SESSION_ID);
      expect(loadedJson.value.recordedAt).toBe("2026-05-03T12:00:00.000Z");
    }
  });

  test("blocks when validation fails", async () => {
    const bad = makeSpec();
    bad.antiSlop.hooks.score_floor.strict = -1;
    const stage = new HarnessDesignStage({ spec: bad });
    const result = await stage.run(ctx());
    expect(result.status).toBe("blocked");
  });
});
