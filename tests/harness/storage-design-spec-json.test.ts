import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  loadHarnessDesignSpecJson,
  saveHarnessDesignSpecJson,
} from "../../src/harness/storage.js";
import { getHarnessDesignSpecJsonPath } from "../../src/harness/project-paths.js";
import { createTestPaths, createTestRepo } from "../ultraplan/fixtures.js";
import type { HarnessDesignSpec } from "../../src/types.js";

const SESSION_ID = "harness-design-spec-json-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-design-json-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSpec(): HarnessDesignSpec {
  return {
    sessionId: SESSION_ID,
    recordedAt: "2026-05-04T12:00:00.000Z",
    layerRules: [
      {
        layer: "domain",
        globs: ["src/domain/**"],
        allowedImports: ["domain"],
        forbiddenImports: ["ui"],
      },
    ],
    tasteInvariants: ["Pure functions in domain"],
    tooling: { lint: "eslint", structuralTest: "fallow", eval: null },
    goldenPrinciples: ["No emojis"],
    docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
    validationGates: [],
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
  };
}

describe("design-spec.json round-trip", () => {
  test("saveHarnessDesignSpecJson writes design-spec.json under the session dir", () => {
    const spec = makeSpec();
    const result = saveHarnessDesignSpecJson(paths, cwd, SESSION_ID, spec);
    expect(result.ok).toBe(true);
    const expectedPath = getHarnessDesignSpecJsonPath(paths, cwd, SESSION_ID);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(path.basename(expectedPath)).toBe("design-spec.json");
  });

  test("loadHarnessDesignSpecJson returns the previously persisted spec", () => {
    const spec = makeSpec();
    saveHarnessDesignSpecJson(paths, cwd, SESSION_ID, spec);
    const loaded = loadHarnessDesignSpecJson(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value).toEqual(spec);
    }
  });

  test("loadHarnessDesignSpecJson returns missing for a fresh session", () => {
    const loaded = loadHarnessDesignSpecJson(paths, cwd, "harness-not-yet-1");
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.kind).toBe("missing");
    }
  });

  test("loadHarnessDesignSpecJson surfaces invalid-json errors", () => {
    const filePath = getHarnessDesignSpecJsonPath(paths, cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ not json", "utf8");
    const loaded = loadHarnessDesignSpecJson(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.kind).toBe("invalid-json");
    }
  });
});
