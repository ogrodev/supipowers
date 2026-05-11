import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  HarnessValidateStage,
  runValidate,
} from "../../../src/harness/stages/validate.js";
import { saveHarnessDiscover } from "../../../src/harness/storage.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { HarnessDiscoverArtifact } from "../../../src/types.js";
import type { HarnessStageRunnerContext } from "../../../src/harness/stage-runner.js";
import type { SlopBackend } from "../../../src/harness/anti_slop/backend.js";

const SESSION_ID = "harness-validate-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-validate-"));
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
    ompInfra: { hasSupipowers: false, skills: [], reviewAgents: [], mcpServers: [], plansCount: 0 },
    antiSlopExisting: {
      fallowConfig: null,
      desloppifyConfig: null,
      knipConfig: null,
      jscpdConfig: null,
      dependencyCruiserConfig: null,
      eslintConfig: null,
      biomeConfig: null,
    },
    languageCoverage: [{ language: "typescript", fileCount: 1, share: 1 }],
    recommendedBackend: "fallow",
    recommendedBackendReason: "TS",
    commitConventions: { detected: false },
    duplicates: [],
    notes: [],
  };
}

function makeContext(overrides: Partial<HarnessStageRunnerContext> = {}): HarnessStageRunnerContext {
  return {
    platform: { paths, exec: mock() } as any,
    paths,
    cwd,
    sessionId: SESSION_ID,
    modelConfig: { version: "1", default: null, actions: {} },
    gateMode: "default",
    now: () => "2026-05-03T12:00:00.000Z",
    ...overrides,
  };
}

function writeArtifacts() {
  fs.writeFileSync(
    path.join(cwd, "AGENTS.md"),
    "# AGENTS\n\nSee docs/architecture.md and docs/golden-principles.md.",
  );
  fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "docs", "architecture.md"),
    "# Architecture\n\n| Layer | Files | Allowed | Forbidden |\n|---|---|---|---|\n| domain | `src/**` | domain | — |\n",
  );
  fs.writeFileSync(path.join(cwd, "docs", "golden-principles.md"), "# Golden\n\n1. Be honest.\n");
}

const NOOP_BACKEND: SlopBackend = {
  id: "fallow",
  async isAvailable() {
    return true;
  },
  async scan() {
    return { ok: true, findings: [], durationMs: 0 };
  },
  async dupes() {
    return { ok: true, findings: [], durationMs: 0 };
  },
  async deadCode() {
    return { ok: true, findings: [], durationMs: 0 };
  },
  async audit() {
    return { ok: true, findings: [], durationMs: 0 };
  },
  async fix() {
    return { ok: true, appliedIds: [], failedIds: [] };
  },
};

describe("runValidate", () => {
  test("flags missing artifacts when AGENTS.md / docs missing", async () => {
    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    const cross = report.checks.find((c) => c.name === "cross-link-check");
    expect(cross?.passed).toBe(false);
    expect(cross?.findings.length).toBeGreaterThan(0);
  });

  test("passes cross-link check when artifacts present", async () => {
    writeArtifacts();
    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    const cross = report.checks.find((c) => c.name === "cross-link-check");
    expect(cross?.passed).toBe(true);
  });

  test("anti-slop scan with adapter returns clean", async () => {
    writeArtifacts();
    const report = await runValidate(makeContext(), {
      backend: "fallow",
      adapter: NOOP_BACKEND,
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    const scan = report.checks.find((c) => c.name === "anti-slop-scan");
    expect(scan?.passed).toBe(true);
  });

  test("score reflects empty queue", async () => {
    writeArtifacts();
    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    expect(report.score.lenient).toBe(100);
    expect(report.score.strict).toBe(100);
  });

  test("every validate check records its guarantee and blind spot", async () => {
    writeArtifacts();
    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    expect(report.checks.length).toBeGreaterThan(0);
    for (const check of report.checks) {
      expect(check.invariant).toBeTruthy();
      expect(check.proves).toBeTruthy();
      expect(check.doesNotProve).toBeTruthy();
      expect(check.artifact).toBeTruthy();
      expect(check.failSafe).toBeTruthy();
    }
  });

  test("blocks when configured CI and local quality command are missing", async () => {
    writeArtifacts();
    const { saveHarnessDesignSpecJson } = await import("../../../src/harness/storage.js");
    saveHarnessDesignSpecJson(paths, cwd, SESSION_ID, {
      sessionId: SESSION_ID,
      recordedAt: "2026-05-03T12:00:00.000Z",
      layerRules: [],
      tasteInvariants: [],
      tooling: { lint: null, structuralTest: null, eval: null },
      goldenPrinciples: [],
      docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
      validationGates: [],
      supipowersWiring: { addReviewAgent: false, wireChecksGate: false },
      ci: {
        provider: "github-actions",
        trigger: { mode: "branches", branches: ["dev"] },
        localCommand: "bun run harness:quality",
        workflowPath: ".github/workflows/harness-quality.yml",
      },
      antiSlop: {
        backend: "supi-native",
        hooks: {
          pre_edit_dupe_probe: { enabled: false, threshold: 0.85, min_token_count: 30 },
          post_session_sweep: { enabled: false, block_on_new_dead_code: false },
          layer_context_inject: { enabled: false, addendum_max_chars: 800 },
          score_floor: { strict: 0, lenient: 0, release_blocking: false },
        },
        skillTargets: [],
      },
    } as any);
    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    const check = report.checks.find((c) => c.name === "ci-local-wiring");
    expect(check?.passed).toBe(false);
    expect(check?.findings.map((f) => f.file)).toContain("package.json");
    expect(check?.findings.map((f) => f.file)).toContain(".github/workflows/harness-quality.yml");
  });

  test("warns (does not block) when prComment is enabled but workflow lacks pull-requests:write", async () => {
    writeArtifacts();
    // Stub the workflow file as present + invoking the right command but WITHOUT a
    // pull-requests:write permission grant. The check should still pass (no errors), but
    // surface a warning-severity finding pointing at the workflow.
    const workflowDir = path.join(cwd, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, "harness-quality.yml"),
      [
        "name: harness",
        "on: { pull_request: { branches: [dev] } }",
        "jobs:",
        "  quality:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: bun run harness:quality",
      ].join("\n"),
    );
    // package.json with the script so the package-script branch passes.
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "x", scripts: { "harness:quality": "echo ok" } }),
    );
    const { saveHarnessDesignSpecJson } = await import("../../../src/harness/storage.js");
    saveHarnessDesignSpecJson(paths, cwd, SESSION_ID, {
      sessionId: SESSION_ID,
      recordedAt: "2026-05-03T12:00:00.000Z",
      layerRules: [],
      tasteInvariants: [],
      tooling: { lint: null, structuralTest: null, eval: null },
      goldenPrinciples: [],
      docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
      validationGates: [],
      supipowersWiring: { addReviewAgent: false, wireChecksGate: false },
      ci: {
        provider: "github-actions",
        trigger: { mode: "branches", branches: ["dev"] },
        localCommand: "bun run harness:quality",
        workflowPath: ".github/workflows/harness-quality.yml",
        prComment: { enabled: true, mode: "every-push" },
      },
      antiSlop: {
        backend: "supi-native",
        hooks: {
          pre_edit_dupe_probe: { enabled: false, threshold: 0.85, min_token_count: 30 },
          post_session_sweep: { enabled: false, block_on_new_dead_code: false },
          layer_context_inject: { enabled: false, addendum_max_chars: 800 },
          score_floor: { strict: 0, lenient: 0, release_blocking: false },
        },
        skillTargets: [],
      },
    } as any);
    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    const check = report.checks.find((c) => c.name === "ci-local-wiring");
    expect(check?.passed).toBe(true);
    const permissionWarning = check?.findings.find(
      (f) => f.severity === "warning" && f.message.includes("pull-requests: write"),
    );
    expect(permissionWarning).toBeDefined();
  });

  test("does NOT warn when workflow grants pull-requests:write", async () => {
    writeArtifacts();
    const workflowDir = path.join(cwd, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, "harness-quality.yml"),
      [
        "name: harness",
        "on: { pull_request: { branches: [dev] } }",
        "permissions:",
        "  contents: read",
        "  pull-requests: write",
        "jobs:",
        "  quality:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: bun run harness:quality",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "x", scripts: { "harness:quality": "echo ok" } }),
    );
    const { saveHarnessDesignSpecJson } = await import("../../../src/harness/storage.js");
    saveHarnessDesignSpecJson(paths, cwd, SESSION_ID, {
      sessionId: SESSION_ID,
      recordedAt: "2026-05-03T12:00:00.000Z",
      layerRules: [],
      tasteInvariants: [],
      tooling: { lint: null, structuralTest: null, eval: null },
      goldenPrinciples: [],
      docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
      validationGates: [],
      supipowersWiring: { addReviewAgent: false, wireChecksGate: false },
      ci: {
        provider: "github-actions",
        trigger: { mode: "branches", branches: ["dev"] },
        localCommand: "bun run harness:quality",
        workflowPath: ".github/workflows/harness-quality.yml",
        prComment: { enabled: true, mode: "every-push" },
      },
      antiSlop: {
        backend: "supi-native",
        hooks: {
          pre_edit_dupe_probe: { enabled: false, threshold: 0.85, min_token_count: 30 },
          post_session_sweep: { enabled: false, block_on_new_dead_code: false },
          layer_context_inject: { enabled: false, addendum_max_chars: 800 },
          score_floor: { strict: 0, lenient: 0, release_blocking: false },
        },
        skillTargets: [],
      },
    } as any);
    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    const check = report.checks.find((c) => c.name === "ci-local-wiring");
    expect(check?.passed).toBe(true);
    const permissionWarning = check?.findings.find(
      (f) => f.message.includes("pull-requests: write"),
    );
    expect(permissionWarning).toBeUndefined();
  });

  /**
   * Helper for the regex-coverage / gate tests below. Writes the workflow file with
   * `workflowYaml`, a minimal package.json with the `harness:quality` script, and a
   * design-spec.json whose `prComment` block is `prComment`. Returns the matching
   * `ci-local-wiring` check from a `runValidate` run.
   */
  async function runWithWorkflowAndPrComment(
    workflowYaml: string,
    prComment: { enabled: boolean; mode: "every-push" | "on-status-change" } | undefined,
  ) {
    writeArtifacts();
    const workflowDir = path.join(cwd, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, "harness-quality.yml"), workflowYaml);
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "x", scripts: { "harness:quality": "echo ok" } }),
    );
    const { saveHarnessDesignSpecJson } = await import("../../../src/harness/storage.js");
    saveHarnessDesignSpecJson(paths, cwd, SESSION_ID, {
      sessionId: SESSION_ID,
      recordedAt: "2026-05-03T12:00:00.000Z",
      layerRules: [],
      tasteInvariants: [],
      tooling: { lint: null, structuralTest: null, eval: null },
      goldenPrinciples: [],
      docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
      validationGates: [],
      supipowersWiring: { addReviewAgent: false, wireChecksGate: false },
      ci: {
        provider: "github-actions",
        trigger: { mode: "branches", branches: ["dev"] },
        localCommand: "bun run harness:quality",
        workflowPath: ".github/workflows/harness-quality.yml",
        ...(prComment ? { prComment } : {}),
      },
      antiSlop: {
        backend: "supi-native",
        hooks: {
          pre_edit_dupe_probe: { enabled: false, threshold: 0.85, min_token_count: 30 },
          post_session_sweep: { enabled: false, block_on_new_dead_code: false },
          layer_context_inject: { enabled: false, addendum_max_chars: 800 },
          score_floor: { strict: 0, lenient: 0, release_blocking: false },
        },
        skillTargets: [],
      },
    } as any);
    const report = await runValidate(makeContext(), {
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    return report.checks.find((c) => c.name === "ci-local-wiring");
  }

  test("inline-mapping `permissions: { pull-requests: write }` is recognised as a grant", async () => {
    const yaml = [
      "name: harness",
      "on: { pull_request: { branches: [dev] } }",
      "permissions: { contents: read, pull-requests: write }",
      "jobs:",
      "  quality:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bun run harness:quality",
    ].join("\n");
    const check = await runWithWorkflowAndPrComment(yaml, { enabled: true, mode: "every-push" });
    expect(check?.passed).toBe(true);
    const permissionWarning = check?.findings.find((f) => f.message.includes("pull-requests: write"));
    expect(permissionWarning).toBeUndefined();
  });

  test("broad `permissions: write-all` is recognised as a grant", async () => {
    const yaml = [
      "name: harness",
      "on: { pull_request: { branches: [dev] } }",
      "permissions: write-all",
      "jobs:",
      "  quality:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bun run harness:quality",
    ].join("\n");
    const check = await runWithWorkflowAndPrComment(yaml, { enabled: true, mode: "every-push" });
    expect(check?.passed).toBe(true);
    const permissionWarning = check?.findings.find((f) => f.message.includes("pull-requests: write"));
    expect(permissionWarning).toBeUndefined();
  });

  test("does NOT warn when prComment is disabled, even if the workflow lacks pull-requests:write", async () => {
    const yaml = [
      "name: harness",
      "on: { pull_request: { branches: [dev] } }",
      "jobs:",
      "  quality:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bun run harness:quality",
    ].join("\n");
    const check = await runWithWorkflowAndPrComment(yaml, { enabled: false, mode: "every-push" });
    expect(check?.passed).toBe(true);
    const permissionWarning = check?.findings.find((f) => f.message.includes("pull-requests: write"));
    expect(permissionWarning).toBeUndefined();
  });
});

describe("HarnessValidateStage", () => {
  test("persists validate-report.json", async () => {
    writeArtifacts();
    const stage = new HarnessValidateStage({
      backend: "supi-native",
      scoreFloor: { strict: 0, lenient: 0, release_blocking: false },
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    const result = await stage.run(makeContext());
    expect(["awaiting-user", "blocked"]).toContain(result.status);
    expect(result.artifactPaths).toContain("validate-report.json");
  });
});
