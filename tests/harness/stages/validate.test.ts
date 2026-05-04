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
