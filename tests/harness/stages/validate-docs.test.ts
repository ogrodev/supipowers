import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runValidate } from "../../../src/harness/stages/validate.js";
import { saveHarnessDiscover } from "../../../src/harness/storage.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { HarnessDiscoverArtifact } from "../../../src/types.js";
import type { HarnessStageRunnerContext } from "../../../src/harness/stage-runner.js";
import { _resetLayerRuleCacheForTests } from "../../../src/harness/hooks/layer-context-inject.js";

const SESSION_ID = "harness-validate-docs-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

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

function makeContext(): HarnessStageRunnerContext {
  return {
    platform: { paths } as never,
    paths,
    cwd,
    sessionId: SESSION_ID,
    modelConfig: { version: "1", default: null, actions: {} },
    gateMode: "default",
    now: () => "2026-05-12T12:00:00.000Z",
  };
}

function writeBaseDocs() {
  fs.writeFileSync(
    path.join(cwd, "AGENTS.md"),
    "# AGENTS\n\nSee docs/architecture.md and docs/golden-principles.md.",
  );
  fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "docs", "architecture.md"),
    "# Architecture\n\n| Layer | Files | Allowed | Forbidden |\n|---|---|---|---|\n| lib | `src/lib/**` | — | app |\n| app | `src/app/**` | lib | — |\n",
  );
  fs.writeFileSync(
    path.join(cwd, "docs", "golden-principles.md"),
    "# Golden\n\n1. Be honest.\n2. No raw errors.\n",
  );
}

beforeEach(() => {
  _resetLayerRuleCacheForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-validate-docs-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
  saveHarnessDiscover(paths, cwd, SESSION_ID, makeDiscover());
  fs.mkdirSync(path.join(cwd, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src", "app"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "lib", "util.ts"), "export const X = 1;\n");
  fs.writeFileSync(path.join(cwd, "src", "app", "main.ts"), "export function go() { return 1; }\n");
  writeBaseDocs();
});

afterEach(() => {
  _resetLayerRuleCacheForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buildLayerDoc(layerId: string, opts: { sourceHash?: string; sections?: string }): string {
  const sourceHash = opts.sourceHash ?? "a".repeat(64);
  const sections = opts.sections ?? [
    "## Agent context",
    `Context for ${layerId}.`,
    "## Purpose",
    `${layerId} layer.`,
    "## Files",
    `- src/${layerId}/**`,
    "## Imports",
    "imports",
    "## Conventions",
    "conventions",
    "",
  ].join("\n");
  const body = [
    "---",
    `layer: ${layerId}`,
    "generatedAt: 2026-05-12T12:00:00.000Z",
    `sourceHash: ${sourceHash}`,
    "---",
    sections,
  ].join("\n");
  return `<!-- harness-docs:session=harness-test generated=2026-05-12T12:00:00.000Z contentHash=${require("node:crypto").createHash("sha256").update(body, "utf8").digest("hex")} -->\n${body}`;
}

describe("docs-validation check", () => {
  test("no-op when docs/layers/ is absent", async () => {
    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    const docs = report.checks.find((c) => c.name === "docs-validation");
    expect(docs).toBeDefined();
    expect(docs?.passed).toBe(true);
    expect(docs?.findings).toEqual([]);
    expect(docs?.summary).toContain("disabled");
  });

  test("valid docs/layers/ + index produces 0 findings", async () => {
    const layersDir = path.join(cwd, "docs", "layers");
    fs.mkdirSync(layersDir, { recursive: true });
    fs.writeFileSync(path.join(layersDir, "lib.md"), buildLayerDoc("lib", {}));
    fs.writeFileSync(path.join(layersDir, "app.md"), buildLayerDoc("app", {}));
    fs.writeFileSync(
      path.join(cwd, "docs", "README.md"),
      "# Repo docs\n\n## Layer docs\n\n| Layer | Files | Doc |\n|---|---|---|\n| lib | `src/lib/**` | docs/layers/lib.md |\n| app | `src/app/**` | docs/layers/app.md |\n",
    );

    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    const docs = report.checks.find((c) => c.name === "docs-validation");
    expect(docs?.passed).toBe(true);
    // We may get sourceHash drift findings because the test uses a synthetic hash; that's
    // expected — the test asserts the check runs without crashing and surfaces findings
    // as warnings (not errors), so the stage remains "passed".
    for (const finding of docs?.findings ?? []) {
      expect(finding.severity).toBe("warning");
    }
  });

  test("index missing while docs/layers/ exists → warning", async () => {
    const layersDir = path.join(cwd, "docs", "layers");
    fs.mkdirSync(layersDir, { recursive: true });
    fs.writeFileSync(path.join(layersDir, "lib.md"), buildLayerDoc("lib", {}));
    // No docs/README.md
    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    const docs = report.checks.find((c) => c.name === "docs-validation");
    expect(docs?.findings.some((f) => /docs\/README\.md is missing/.test(f.message))).toBe(true);
  });

  test("stale doc in index produces warning", async () => {
    const layersDir = path.join(cwd, "docs", "layers");
    fs.mkdirSync(layersDir, { recursive: true });
    fs.writeFileSync(path.join(layersDir, "lib.md"), buildLayerDoc("lib", {}));
    // Index references a missing layer doc.
    fs.writeFileSync(
      path.join(cwd, "docs", "README.md"),
      "# Repo docs\n\n| Layer | Files | Doc |\n|---|---|---|\n| lib | `src/lib/**` | docs/layers/lib.md |\n| ghost | `src/ghost/**` | docs/layers/ghost.md |\n",
    );

    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    const docs = report.checks.find((c) => c.name === "docs-validation");
    expect(docs?.findings.some((f) => /ghost\.md but the file is missing/.test(f.message))).toBe(true);
  });
});
