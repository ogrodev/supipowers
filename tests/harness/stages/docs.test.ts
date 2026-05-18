import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HarnessDocsStage } from "../../../src/harness/stages/docs.js";
import {
  saveHarnessDesignSpecJson,
  saveHarnessDiscover,
  saveHarnessDocsLayerStaging,
  saveHarnessSession,
} from "../../../src/harness/storage.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { HarnessStageRunnerContext } from "../../../src/harness/stage-runner.js";
import type { HarnessDesignSpec, HarnessDiscoverArtifact, HarnessSession } from "../../../src/types.js";
import type { Platform } from "../../../src/platform/types.js";

const SESSION_ID = "harness-docs-progress-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

function makeDiscover(): HarnessDiscoverArtifact {
  return {
    sessionId: SESSION_ID,
    recordedAt: "2026-05-18T00:00:00.000Z",
    languages: ["typescript"],
    frameworks: [],
    packageManagers: ["bun"],
    buildTools: ["tsc"],
    testTools: ["bun:test"],
    lintTools: [],
    monorepoShape: "single-package",
    ci: { detected: false, configFiles: [] },
    ompInfra: { hasSupipowers: true, skills: [], reviewAgents: [], plansCount: 0 },
    antiSlopExisting: {
      fallowConfig: null,
      desloppifyConfig: null,
      knipConfig: null,
      jscpdConfig: null,
      dependencyCruiserConfig: null,
      eslintConfig: null,
      biomeConfig: null,
    },
    languageCoverage: [{ language: "typescript", fileCount: 2, share: 100 }],
    recommendedBackend: "fallow",
    recommendedBackendReason: "typescript repo",
    commitConventions: { detected: false },
    duplicates: [],
    notes: [],
  };
}

function makeDesignSpec(): HarnessDesignSpec {
  return {
    sessionId: SESSION_ID,
    recordedAt: "2026-05-18T00:00:00.000Z",
    layerRules: [
      { layer: "lib", globs: ["src/lib/**"], allowedImports: [], forbiddenImports: [], description: "Library code" },
      { layer: "app", globs: ["src/app/**"], allowedImports: ["lib"], forbiddenImports: [], description: "Application code" },
    ],
    tasteInvariants: [],
    tooling: { lint: null, structuralTest: "bun:test", eval: null },
    goldenPrinciples: ["Use typed boundaries."],
    docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
    validationGates: [],
    ci: {
      provider: "github-actions",
      trigger: { mode: "branches", branches: ["main"] },
      localCommand: "bun ci",
      workflowPath: ".github/workflows/ci.yml",
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
      skillTargets: [],
    },
  };
}

function makeSession(): HarnessSession {
  return {
    sessionId: SESSION_ID,
    projectName: "supipowers",
    startedAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    stage: "docs",
    stageStatus: "pending",
    gateMode: "default",
    iteration: 1,
    blocker: null,
    artifacts: {},
    docsTier: "extensive",
  };
}

function makeContext(onProgress: HarnessStageRunnerContext["onProgress"]): HarnessStageRunnerContext {
  return {
    platform: { paths } as unknown as Platform,
    paths,
    cwd,
    sessionId: SESSION_ID,
    modelConfig: { version: "1", default: null, actions: {} },
    gateMode: "auto",
    now: () => "2026-05-18T00:00:00.000Z",
    onProgress,
  } as HarnessStageRunnerContext;
}

function layerDoc(layerId: string, sourceHash: string): string {
  const body = [
    "---",
    `layer: ${layerId}`,
    "generatedAt: 2026-05-18T00:00:00.000Z",
    `sourceHash: ${sourceHash}`,
    "---",
    "## Agent context",
    `${layerId} context from representative files.`,
    "## Purpose",
    `${layerId} layer docs.`,
    "## Files",
    `- src/${layerId}/**`,
    "## Imports",
    "Follow the layer rule supplied by the harness.",
    "## Conventions",
    "Reference repo-wide golden principles instead of restating them.",
  ].join("\n");
  const contentHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  return `<!-- harness-docs:session=${SESSION_ID} generated=2026-05-18T00:00:00.000Z contentHash=${contentHash} -->\n${body}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-docs-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
  fs.mkdirSync(path.join(cwd, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src", "app"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "lib", "util.ts"), "export function util(): number { return 1; }\n");
  fs.writeFileSync(path.join(cwd, "src", "app", "main.ts"), "import { util } from '../lib/util';\nexport function main(): number { return util(); }\n");
  fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "docs", "golden-principles.md"), "# Golden\n\n1. Use typed boundaries.\n");
  saveHarnessSession(paths, cwd, makeSession());
  saveHarnessDiscover(paths, cwd, SESSION_ID, makeDiscover());
  saveHarnessDesignSpecJson(paths, cwd, SESSION_ID, makeDesignSpec());
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("HarnessDocsStage progress", () => {
  test("emits live subagent events while generating per-layer docs", async () => {
    const progress: Array<{ type: string; stage?: string; detail?: string }> = [];
    const stage = new HarnessDocsStage({
      tierOverride: "extensive",
      agentSessionFactory: async () => {
        const subscribers: Array<(event: unknown) => void> = [];
        return {
          subscribe(handler: (event: unknown) => void) {
            subscribers.push(handler);
            return () => {};
          },
          async prompt(assignment: string) {
            const layerId = assignment.match(/^Layer id: (.+)$/m)?.[1];
            const sourceHash = assignment.match(/^Embed sourceHash: ([0-9a-f]{64})/m)?.[1];
            if (!layerId || !sourceHash) throw new Error("assignment missing layer metadata");
            for (const subscriber of subscribers) {
              subscriber({ type: "assistant_thought", text: `Reading representative files for ${layerId}` });
              subscriber({ type: "tool_call", name: "harness_docs_record" });
            }
            saveHarnessDocsLayerStaging(paths, cwd, SESSION_ID, layerId, layerDoc(layerId, sourceHash));
          },
          async dispose() {},
        } as any;
      },
    });

    const result = await stage.run(makeContext((event) => progress.push(event)));

    expect(result.status).toBe("completed");
    expect(progress.some((event) => event.type === "stage-progress" && event.detail?.includes("Reading representative files"))).toBe(true);
    expect(progress.some((event) => event.type === "stage-progress" && event.detail?.includes("harness_docs_record"))).toBe(true);
  });
});
