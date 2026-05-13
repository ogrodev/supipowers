import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildResearchTopicPlan,
  HarnessResearchStage,
  renderResearchTopicStub,
  validateResearchTopic,
} from "../../../src/harness/stages/research.js";
import { saveHarnessDiscover } from "../../../src/harness/storage.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { HarnessStageRunnerContext } from "../../../src/harness/stage-runner.js";
import type { HarnessDiscoverArtifact } from "../../../src/types.js";

const SESSION_ID = "harness-research-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-research-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

function makeDiscover(languages: string[]): HarnessDiscoverArtifact {
  return {
    sessionId: SESSION_ID,
    recordedAt: "2026-05-03T12:00:00.000Z",
    languages,
    frameworks: [],
    packageManagers: [],
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
    languageCoverage: languages.map((l) => ({ language: l, fileCount: 1, share: 1 / languages.length })),
    recommendedBackend: "fallow",
    recommendedBackendReason: "test",
    commitConventions: { detected: false },
    duplicates: [],
    notes: [],
  };
}

describe("buildResearchTopicPlan", () => {
  test("emits base topics + per-language topics for ≤2 languages", () => {
    const plan = buildResearchTopicPlan({ languages: ["typescript"] });
    const slugs = plan.map((t) => t.slug);
    expect(slugs).toContain("agents-md-best-practices");
    expect(slugs).toContain("layered-architecture-enforcement-typescript");
  });

  test("collapses to polyglot bucket for ≥3 languages", () => {
    const plan = buildResearchTopicPlan({ languages: ["typescript", "python", "go"] });
    const slugs = plan.map((t) => t.slug);
    expect(slugs).toContain("layered-architecture-enforcement-polyglot");
    expect(slugs.find((s) => s === "layered-architecture-enforcement-typescript")).toBeUndefined();
  });
});

describe("renderResearchTopicStub", () => {
  test("includes the mandatory headings", () => {
    const stub = renderResearchTopicStub({
      topic: { slug: "x", title: "X", context: "ctx" },
      recordedAt: "2026-05-03T12:00:00.000Z",
    });
    expect(stub).toContain("## Options");
    expect(stub).toContain("## Recommendation");
    expect(stub).toContain("## Sources");
  });
});

describe("validateResearchTopic", () => {
  test("stub fails validation (no sources)", () => {
    const stub = renderResearchTopicStub({
      topic: { slug: "x", title: "X", context: "ctx" },
      recordedAt: "2026-05-03T12:00:00.000Z",
    });
    const errors = validateResearchTopic(stub);
    expect(errors.find((e) => e.includes("source URLs"))).toBeDefined();
  });

  test("filled writeup passes validation", () => {
    const md = [
      "## Options",
      "Some options https://docs.example.com/a",
      "## Recommendation",
      "Pick A; see https://docs.example.com/b",
    ].join("\n");
    expect(validateResearchTopic(md)).toEqual([]);
  });

  test("missing Recommendation flagged", () => {
    const md = "## Options\n\nhttps://a https://b";
    const errors = validateResearchTopic(md);
    expect(errors.find((e) => e.includes("Recommendation"))).toBeDefined();
  });
});

describe("HarnessResearchStage", () => {
  test("blocks when discover missing", async () => {
    const stage = new HarnessResearchStage();
    const result = await stage.run(ctx());
    expect(result.status).toBe("blocked");
  });

  test("emits a stub per topic when discover present", async () => {
    saveHarnessDiscover(paths, cwd, SESSION_ID, makeDiscover(["typescript"]));
    const stage = new HarnessResearchStage();
    const result = await stage.run(ctx());
    expect(result.status).toBe("completed");
    expect((result.artifactPaths as string[]).length).toBeGreaterThan(0);
  });

  test("re-running is a skip", async () => {
    saveHarnessDiscover(paths, cwd, SESSION_ID, makeDiscover(["typescript"]));
    const stage = new HarnessResearchStage();
    await stage.run(ctx());
    const re = await stage.run(ctx());
    expect(re.status).toBe("skipped");
  });
});
