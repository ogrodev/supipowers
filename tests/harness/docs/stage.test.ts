import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HarnessDocsStage } from "../../../src/harness/stages/docs.js";
import { computeBodyContentHash } from "../../../src/harness/docs/provenance.js";
import {
  registerDocsLayerExpectation,
  _clearAllDocsLayerExpectationsForTests,
  lookupDocsLayerExpectation,
  clearDocsLayerExpectation,
} from "../../../src/harness/tools.js";
import {
  saveHarnessDesignSpecJson,
  saveHarnessDiscover,
  saveHarnessDocsLayerStaging,
  saveHarnessSession,
} from "../../../src/harness/storage.js";
import {
  getHarnessDocsStagingLayerPath,
  getHarnessRepoDocsLayerPath,
  getHarnessRepoDocsReadmePath,
} from "../../../src/harness/project-paths.js";
import { createTestPaths } from "../../ultraplan/fixtures.js";
import { newHarnessSessionId } from "../../../src/harness/stage-runner.js";
import type {
  HarnessDesignSpec,
  HarnessDiscoverArtifact,
  HarnessSession,
  ModelConfig,
} from "../../../src/types.js";

let tmp: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;
let sessionId: string;

function modelConfig(): ModelConfig {
  return { version: "1", default: null, actions: {} };
}

function freshSession(id: string, docsTier?: "simple" | "extensive"): HarnessSession {
  const ts = new Date().toISOString();
  return {
    sessionId: id,
    projectName: "supipowers",
    startedAt: ts,
    updatedAt: ts,
    stage: "docs",
    stageStatus: "pending",
    gateMode: "auto",
    iteration: 1,
    docsTier,
    blocker: null,
    artifacts: {},
  };
}

function discover(id: string): HarnessDiscoverArtifact {
  return {
    sessionId: id,
    recordedAt: new Date().toISOString(),
    languages: ["typescript"],
    frameworks: [],
    packageManagers: ["bun"],
    buildTools: ["tsc"],
    testTools: ["bun:test"],
    lintTools: [],
    monorepoShape: "single-package",
    ci: { detected: false, configFiles: [] },
    ompInfra: {
      hasSupipowers: true,
      skills: [],
      reviewAgents: [],
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
    languageCoverage: [{ language: "typescript", fileCount: 1, share: 100 }],
    recommendedBackend: "fallow",
    recommendedBackendReason: "primary language is typescript",
    commitConventions: { detected: false },
    duplicates: [],
    notes: [],
  };
}

function designSpec(id: string, layers: HarnessDesignSpec["layerRules"]): HarnessDesignSpec {
  return {
    sessionId: id,
    recordedAt: new Date().toISOString(),
    layerRules: layers,
    tasteInvariants: [],
    tooling: { lint: null, structuralTest: null, eval: null },
    goldenPrinciples: ["Every exported function has an explicit return type."],
    docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
    validationGates: [],
    ci: {
      provider: "github-actions",
      trigger: { mode: "branches", branches: ["main"] },
      localCommand: "bun ci",
      workflowPath: ".github/workflows/harness-quality.yml",
    },
    supipowersWiring: { addReviewAgent: false, wireChecksGate: false },
    antiSlop: { backend: "fallow", hooks: { pre_edit_dupe_probe: { enabled: false, threshold: 0.85, min_token_count: 30 }, post_session_sweep: { enabled: false, block_on_new_dead_code: false }, layer_context_inject: { enabled: false, addendum_max_chars: 800 }, score_floor: { strict: 75, lenient: 90, release_blocking: false } }, skillTargets: [] },
  };
}

const TWO_LAYERS = [
  { layer: "lib", globs: ["src/lib/**"], allowedImports: [] as string[], forbiddenImports: [] as string[], description: "Library code" },
  { layer: "app", globs: ["src/app/**"], allowedImports: ["lib"], forbiddenImports: [] as string[], description: "Application code" },
];

function writeRepoFile(rel: string, contents: string): void {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function buildDocFor(layerId: string, sourceHash: string, body?: string): string {
  const sections = body ?? [
    "## Agent context",
    `Context for ${layerId}.`,
    "## Purpose",
    `${layerId} layer.`,
    "## Files",
    "files",
    "## Imports",
    "imports",
    "## Conventions",
    "conventions",
    "",
  ].join("\n");
  const docBody = [
    "---",
    `layer: ${layerId}`,
    "generatedAt: 2026-05-12T12:00:00.000Z",
    `sourceHash: ${sourceHash}`,
    "---",
    sections,
  ].join("\n");
  const marker = `<!-- harness-docs:session=${sessionId} generated=2026-05-12T12:00:00.000Z contentHash=${computeBodyContentHash(docBody)} -->`;
  return `${marker}\n${docBody}`;
}

beforeEach(() => {
  _clearAllDocsLayerExpectationsForTests();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supi-docs-stage-"));
  cwd = path.join(tmp, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  paths = createTestPaths(tmp);
  sessionId = newHarnessSessionId();
  saveHarnessDiscover(paths, cwd, sessionId, discover(sessionId));
  // Seed repo files so the glob has content.
  writeRepoFile("src/lib/util.ts", "export const X = 1;\n");
  writeRepoFile("src/app/main.ts", "import { X } from '../lib/util.js';\nexport function run() { return X; }\n");
});

afterEach(() => {
  _clearAllDocsLayerExpectationsForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("HarnessDocsStage", () => {
  test("simple tier is a no-op", async () => {
    saveHarnessSession(paths, cwd, freshSession(sessionId, "simple"));
    saveHarnessDesignSpecJson(paths, cwd, sessionId, designSpec(sessionId, TWO_LAYERS));
    const stage = new HarnessDocsStage();
    const result = await stage.run({
      platform: { paths } as never,
      paths,
      cwd,
      sessionId,
      modelConfig: modelConfig(),
      gateMode: "auto",
    });
    expect(result.status).toBe("skipped");
    expect(result.details?.reason).toContain("simple");
    expect(fs.existsSync(getHarnessRepoDocsReadmePath(paths, cwd))).toBe(false);
  });

  test("extensive tier with <2 layer rules collapses to Tier 1", async () => {
    saveHarnessSession(paths, cwd, freshSession(sessionId, "extensive"));
    saveHarnessDesignSpecJson(paths, cwd, sessionId, designSpec(sessionId, [TWO_LAYERS[0]]));
    const stage = new HarnessDocsStage();
    const result = await stage.run({
      platform: { paths } as never,
      paths,
      cwd,
      sessionId,
      modelConfig: modelConfig(),
      gateMode: "auto",
    });
    expect(result.status).toBe("skipped");
    expect(result.details?.reason).toContain("fewer than 2 layer rules");
  });

  test("fresh run: dispatches subagents, writes layer docs and index", async () => {
    saveHarnessSession(paths, cwd, freshSession(sessionId, "extensive"));
    saveHarnessDesignSpecJson(paths, cwd, sessionId, designSpec(sessionId, TWO_LAYERS));

    const stage = new HarnessDocsStage({
      agentSessionFactory: async (_platform, options) => ({
        async prompt(_text, _opts) {
          // Resolve the layer id from the agent display name.
          const m = options.agentDisplayName.match(/\/(.+)$/);
          const layerId = m ? m[1] : "lib";
          const expectation = lookupDocsLayerExpectation(sessionId, layerId);
          if (!expectation) return;
          const doc = buildDocFor(layerId, expectation.expectedSourceHash);
          saveHarnessDocsLayerStaging(paths, cwd, sessionId, layerId, doc);
        },
        async dispose() {},
      }),
    });

    const result = await stage.run({
      platform: { paths } as never,
      paths,
      cwd,
      sessionId,
      modelConfig: modelConfig(),
      gateMode: "auto",
    });

    expect(result.status).toBe("completed");
    expect(result.details?.regenerated).toEqual(["lib", "app"]);
    expect(result.details?.skipped).toEqual([]);
    expect(fs.existsSync(getHarnessRepoDocsLayerPath(paths, cwd, "lib"))).toBe(true);
    expect(fs.existsSync(getHarnessRepoDocsLayerPath(paths, cwd, "app"))).toBe(true);
    expect(fs.existsSync(getHarnessRepoDocsReadmePath(paths, cwd))).toBe(true);
    // Index references both layers
    const indexContent = fs.readFileSync(getHarnessRepoDocsReadmePath(paths, cwd), "utf8");
    expect(indexContent).toContain("docs/layers/lib.md");
    expect(indexContent).toContain("docs/layers/app.md");
  });

  test("re-run with no changes: all layers skipped", async () => {
    saveHarnessSession(paths, cwd, freshSession(sessionId, "extensive"));
    saveHarnessDesignSpecJson(paths, cwd, sessionId, designSpec(sessionId, TWO_LAYERS));

    const captureExpectations = new Map<string, string>();
    const factory: NonNullable<ConstructorParameters<typeof HarnessDocsStage>[0]>["agentSessionFactory"] =
      async (_platform, options) => ({
        async prompt(_text, _opts) {
          const m = options.agentDisplayName.match(/\/(.+)$/);
          const layerId = m ? m[1] : "lib";
          const expectation = lookupDocsLayerExpectation(sessionId, layerId);
          if (!expectation) return;
          captureExpectations.set(layerId, expectation.expectedSourceHash);
          const doc = buildDocFor(layerId, expectation.expectedSourceHash);
          saveHarnessDocsLayerStaging(paths, cwd, sessionId, layerId, doc);
        },
        async dispose() {},
      });

    // First run.
    await new HarnessDocsStage({ agentSessionFactory: factory }).run({
      platform: { paths } as never,
      paths,
      cwd,
      sessionId,
      modelConfig: modelConfig(),
      gateMode: "auto",
    });

    let dispatchCount = 0;
    const reFactory: typeof factory = async (...args) => {
      dispatchCount += 1;
      return factory(...args);
    };

    const second = await new HarnessDocsStage({ agentSessionFactory: reFactory }).run({
      platform: { paths } as never,
      paths,
      cwd,
      sessionId,
      modelConfig: modelConfig(),
      gateMode: "auto",
    });

    expect(second.status).toBe("completed");
    expect(second.details?.regenerated).toEqual([]);
    expect(second.details?.skipped).toEqual(["lib", "app"]);
    // No subagent calls when everything is up-to-date.
    expect(dispatchCount).toBe(0);
  });

  test("source file edit invalidates only the affected layer", async () => {
    saveHarnessSession(paths, cwd, freshSession(sessionId, "extensive"));
    saveHarnessDesignSpecJson(paths, cwd, sessionId, designSpec(sessionId, TWO_LAYERS));

    const factory: NonNullable<ConstructorParameters<typeof HarnessDocsStage>[0]>["agentSessionFactory"] =
      async (_platform, options) => ({
        async prompt(_text, _opts) {
          const m = options.agentDisplayName.match(/\/(.+)$/);
          const layerId = m ? m[1] : "lib";
          const expectation = lookupDocsLayerExpectation(sessionId, layerId);
          if (!expectation) return;
          const doc = buildDocFor(layerId, expectation.expectedSourceHash);
          saveHarnessDocsLayerStaging(paths, cwd, sessionId, layerId, doc);
        },
        async dispose() {},
      });

    await new HarnessDocsStage({ agentSessionFactory: factory }).run({
      platform: { paths } as never,
      paths,
      cwd,
      sessionId,
      modelConfig: modelConfig(),
      gateMode: "auto",
    });

    // Edit a lib file — only lib should regen.
    writeRepoFile("src/lib/util.ts", "export const X = 42;\nexport const Y = 7;\n");

    const dispatched: string[] = [];
    const reFactory: typeof factory = async (_platform, options) => {
      const m = options.agentDisplayName.match(/\/(.+)$/);
      const layerId = m ? m[1] : "lib";
      dispatched.push(layerId);
      return factory(_platform, options);
    };

    const second = await new HarnessDocsStage({ agentSessionFactory: reFactory }).run({
      platform: { paths } as never,
      paths,
      cwd,
      sessionId,
      modelConfig: modelConfig(),
      gateMode: "auto",
    });

    expect(second.status).toBe("completed");
    expect(second.details?.regenerated).toEqual(["lib"]);
    expect(second.details?.skipped).toEqual(["app"]);
    expect(dispatched).toEqual(["lib"]);
  });

  test("user-edited doc is preserved (other layers regen)", async () => {
    saveHarnessSession(paths, cwd, freshSession(sessionId, "extensive"));
    saveHarnessDesignSpecJson(paths, cwd, sessionId, designSpec(sessionId, TWO_LAYERS));

    const factory: NonNullable<ConstructorParameters<typeof HarnessDocsStage>[0]>["agentSessionFactory"] =
      async (_platform, options) => ({
        async prompt(_text, _opts) {
          const m = options.agentDisplayName.match(/\/(.+)$/);
          const layerId = m ? m[1] : "lib";
          const expectation = lookupDocsLayerExpectation(sessionId, layerId);
          if (!expectation) return;
          const doc = buildDocFor(layerId, expectation.expectedSourceHash);
          saveHarnessDocsLayerStaging(paths, cwd, sessionId, layerId, doc);
        },
        async dispose() {},
      });

    await new HarnessDocsStage({ agentSessionFactory: factory }).run({
      platform: { paths } as never,
      paths,
      cwd,
      sessionId,
      modelConfig: modelConfig(),
      gateMode: "auto",
    });

    // Hand-edit the lib doc.
    const libPath = getHarnessRepoDocsLayerPath(paths, cwd, "lib");
    fs.appendFileSync(libPath, "\nuser-added note\n");
    // Edit app source so app regens.
    writeRepoFile("src/app/main.ts", "export function run2() { return 0; }\n");

    const second = await new HarnessDocsStage({ agentSessionFactory: factory }).run({
      platform: { paths } as never,
      paths,
      cwd,
      sessionId,
      modelConfig: modelConfig(),
      gateMode: "auto",
    });

    expect(second.status).toBe("completed");
    expect(second.details?.userEdited).toEqual(["lib"]);
    expect(second.details?.regenerated).toEqual(["app"]);
    // user-edited content preserved
    const libContents = fs.readFileSync(libPath, "utf8");
    expect(libContents.includes("user-added note")).toBe(true);
  });

  test("subagent fails to stage anything → blocked", async () => {
    saveHarnessSession(paths, cwd, freshSession(sessionId, "extensive"));
    saveHarnessDesignSpecJson(paths, cwd, sessionId, designSpec(sessionId, TWO_LAYERS));

    const stage = new HarnessDocsStage({
      agentSessionFactory: async () => ({
        async prompt() {
          // does nothing → no staged file → runner blocks after retry
        },
        async dispose() {},
      }),
    });

    const result = await stage.run({
      platform: { paths } as never,
      paths,
      cwd,
      sessionId,
      modelConfig: modelConfig(),
      gateMode: "auto",
    });

    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("doc-generation-failed");
    // No partial promotion.
    expect(fs.existsSync(getHarnessRepoDocsReadmePath(paths, cwd))).toBe(false);
  });

  test("expectation registry is cleared after the layer finishes", async () => {
    saveHarnessSession(paths, cwd, freshSession(sessionId, "extensive"));
    saveHarnessDesignSpecJson(paths, cwd, sessionId, designSpec(sessionId, TWO_LAYERS));

    const factory: NonNullable<ConstructorParameters<typeof HarnessDocsStage>[0]>["agentSessionFactory"] =
      async (_platform, options) => ({
        async prompt() {
          const m = options.agentDisplayName.match(/\/(.+)$/);
          const layerId = m ? m[1] : "lib";
          const expectation = lookupDocsLayerExpectation(sessionId, layerId);
          if (!expectation) return;
          const doc = buildDocFor(layerId, expectation.expectedSourceHash);
          saveHarnessDocsLayerStaging(paths, cwd, sessionId, layerId, doc);
        },
        async dispose() {},
      });

    await new HarnessDocsStage({ agentSessionFactory: factory }).run({
      platform: { paths } as never,
      paths,
      cwd,
      sessionId,
      modelConfig: modelConfig(),
      gateMode: "auto",
    });

    expect(lookupDocsLayerExpectation(sessionId, "lib")).toBeNull();
    expect(lookupDocsLayerExpectation(sessionId, "app")).toBeNull();
  });

  // Touch unused helpers so the linter is happy in test compile.
  void clearDocsLayerExpectation;
  void registerDocsLayerExpectation;
  void getHarnessDocsStagingLayerPath;
});
