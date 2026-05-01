import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  appendDecisionRecord,
  appendPipelineLog,
  clearAuthoringState,
  deleteResearchStackArtifact,
  ensureDraftIterationDir,
  hasAuthoringWorkspace,
  loadAuthoringState,
  loadDeferredIdeas,
  loadDiscussArtifact,
  loadDraftAuthoredJson,
  loadDraftAuthoredMarkdown,
  loadFindingsArtifact,
  loadIntakeArtifact,
  loadResearchStackArtifact,
  loadResearchSummary,
  loadScoutArtifact,
  readPipelineLog,
  saveAuthoringState,
  saveDeferredIdeas,
  saveDiscussArtifact,
  saveDraftAuthoredJson,
  saveDraftAuthoredMarkdown,
  saveDraftPlannerJson,
  saveFindingsArtifact,
  saveIntakeArtifact,
  saveResearchStackArtifact,
  saveResearchSummary,
  saveScoutArtifact,
} from "../../../src/ultraplan/authoring/storage.js";
import {
  getUltraplanAuthoringDecisionsPath,
  getUltraplanAuthoringDir,
  getUltraplanAuthoringDraftIterationDir,
  getUltraplanAuthoringDraftPlannerJsonPath,
  getUltraplanAuthoringPipelineLogPath,
} from "../../../src/ultraplan/project-paths.js";
import { saveUltraPlanManifest } from "../../../src/ultraplan/storage.js";
import type {
  UltraPlanAuthoringFindingsArtifact,
  UltraPlanAuthoringPipelineEvent,
  UltraPlanAuthoringState,
} from "../../../src/types.js";
import { createTestPaths, createTestRepo, makeUltraPlanManifest } from "../fixtures.js";

const SESSION_ID = "up-author-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-authoring-storage-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;

  // Seed a manifest so authoring state save/load has a host artifact.
  const manifest = makeUltraPlanManifest({ sessionId: SESSION_ID });
  const result = saveUltraPlanManifest(paths, cwd, SESSION_ID, manifest);
  expect(result.ok).toBe(true);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeAuthoringState(
  overrides: Partial<UltraPlanAuthoringState> = {},
): UltraPlanAuthoringState {
  return {
    pipeline: "multi-stage",
    stage: "intake",
    stageStatus: "running",
    iteration: 1,
    stallReentryCount: 0,
    artifacts: {},
    blocker: null,
    startedAt: "2026-04-30T12:00:00.000Z",
    updatedAt: "2026-04-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("authoring storage — authoring state on manifest", () => {
  test("loadAuthoringState returns null when manifest has no authoring block", () => {
    const result = loadAuthoringState(paths, cwd, SESSION_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  test("save then load round-trips the authoring block", () => {
    const state = makeAuthoringState({ stage: "scout" });
    const saved = saveAuthoringState(paths, cwd, SESSION_ID, state);
    expect(saved.ok).toBe(true);

    const loaded = loadAuthoringState(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value).not.toBeNull();
      expect(loaded.value?.stage).toBe("scout");
      expect(loaded.value?.iteration).toBe(1);
    }
  });

  test("save rejects invalid authoring state (negative iteration)", () => {
    const bad = makeAuthoringState({ iteration: 0 });
    const saved = saveAuthoringState(paths, cwd, SESSION_ID, bad);
    expect(saved.ok).toBe(false);
    if (!saved.ok) {
      expect(saved.error.kind).toBe("validation-error");
    }
  });

  test("clearAuthoringState removes the authoring block", () => {
    const state = makeAuthoringState();
    saveAuthoringState(paths, cwd, SESSION_ID, state);

    const cleared = clearAuthoringState(paths, cwd, SESSION_ID);
    expect(cleared.ok).toBe(true);

    const loaded = loadAuthoringState(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toBeNull();
  });
});

describe("authoring storage — stage artifacts (intake/scout/discuss)", () => {
  test("intake JSON round-trips", () => {
    const intake = { title: "Build auth", goal: "ship sign-in", stacks: ["backend"] };
    const saved = saveIntakeArtifact(paths, cwd, SESSION_ID, intake);
    expect(saved.ok).toBe(true);

    const loaded = loadIntakeArtifact(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toEqual(intake);
  });

  test("scout JSON round-trips", () => {
    const scout = { reusable: ["src/auth/jwt.ts"], conventions: ["uses zod"] };
    const saved = saveScoutArtifact(paths, cwd, SESSION_ID, scout);
    expect(saved.ok).toBe(true);

    const loaded = loadScoutArtifact(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toEqual(scout);
  });

  test("discuss markdown round-trips and ensures trailing newline", () => {
    const md = "# Decisions\n\n- Use JWT";
    const saved = saveDiscussArtifact(paths, cwd, SESSION_ID, md);
    expect(saved.ok).toBe(true);

    const loaded = loadDiscussArtifact(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.startsWith("# Decisions")).toBe(true);
      expect(loaded.value.endsWith("\n")).toBe(true);
    }
  });

  test("deferred ideas markdown round-trips", () => {
    const md = "- Maybe later: rate limiting";
    saveDeferredIdeas(paths, cwd, SESSION_ID, md);

    const loaded = loadDeferredIdeas(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.includes("rate limiting")).toBe(true);
  });

  test("appendDecisionRecord writes one JSONL line per call", () => {
    appendDecisionRecord(paths, cwd, SESSION_ID, { area: "auth", choice: "JWT" });
    appendDecisionRecord(paths, cwd, SESSION_ID, { area: "storage", choice: "Postgres" });

    const decisionsPath = getUltraplanAuthoringDecisionsPath(paths, cwd, SESSION_ID);
    const raw = fs.readFileSync(decisionsPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual({ area: "auth", choice: "JWT" });
    expect(JSON.parse(lines[1]!)).toEqual({ area: "storage", choice: "Postgres" });
  });

  test("research stack artifact save/load + delete", () => {
    const md = "# Backend research\n- Library: better-auth";
    saveResearchStackArtifact(paths, cwd, SESSION_ID, "backend", md);

    const loaded = loadResearchStackArtifact(paths, cwd, SESSION_ID, "backend");
    expect(loaded.ok).toBe(true);

    const deleted = deleteResearchStackArtifact(paths, cwd, SESSION_ID, "backend");
    expect(deleted.ok).toBe(true);

    const reloaded = loadResearchStackArtifact(paths, cwd, SESSION_ID, "backend");
    expect(reloaded.ok).toBe(false);
    if (!reloaded.ok) expect(reloaded.error.kind).toBe("missing");
  });

  test("delete on missing research artifact is a no-op", () => {
    const result = deleteResearchStackArtifact(paths, cwd, SESSION_ID, "frontend");
    expect(result.ok).toBe(true);
  });

  test("research summary round-trips", () => {
    saveResearchSummary(paths, cwd, SESSION_ID, "# Summary\n- Backend ready");
    const loaded = loadResearchSummary(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
  });
});

describe("authoring storage — drafts", () => {
  test("ensureDraftIterationDir creates the directory", () => {
    const dir = ensureDraftIterationDir(paths, cwd, SESSION_ID, 1);
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toBe(getUltraplanAuthoringDraftIterationDir(paths, cwd, SESSION_ID, 1));
  });

  test("draft authored JSON round-trips per iteration", () => {
    const draft1 = { iteration: 1 };
    const draft2 = { iteration: 2 };
    saveDraftAuthoredJson(paths, cwd, SESSION_ID, 1, draft1);
    saveDraftAuthoredJson(paths, cwd, SESSION_ID, 2, draft2);

    const r1 = loadDraftAuthoredJson(paths, cwd, SESSION_ID, 1);
    const r2 = loadDraftAuthoredJson(paths, cwd, SESSION_ID, 2);
    expect(r1.ok && r1.value).toEqual(draft1);
    expect(r2.ok && r2.value).toEqual(draft2);
  });

  test("draft authored markdown round-trips", () => {
    saveDraftAuthoredMarkdown(paths, cwd, SESSION_ID, 1, "# Authored\n");
    const loaded = loadDraftAuthoredMarkdown(paths, cwd, SESSION_ID, 1);
    expect(loaded.ok).toBe(true);
  });

  test("planner-original JSON snapshot is written next to authored.json", () => {
    saveDraftPlannerJson(paths, cwd, SESSION_ID, 1, { source: "planner" });
    const plannerPath = getUltraplanAuthoringDraftPlannerJsonPath(paths, cwd, SESSION_ID, 1);
    expect(fs.existsSync(plannerPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(plannerPath, "utf8"))).toEqual({ source: "planner" });
  });

  test("findings artifact validates and round-trips", () => {
    const findings: UltraPlanAuthoringFindingsArtifact = {
      iteration: 1,
      draftRef: "drafts/iteration-1/authored.json",
      recordedAt: "2026-04-30T13:00:00.000Z",
      findings: [
        {
          id: "f1",
          severity: "BLOCKER",
          source: "structure-checker",
          target: { stack: "backend", domainId: null, scenarioId: null },
          message: "Missing TDD ownership",
          recommendation: "Add red-running step",
          recordedAt: "2026-04-30T13:00:00.000Z",
        },
      ],
    };
    const saved = saveFindingsArtifact(paths, cwd, SESSION_ID, 1, findings);
    expect(saved.ok).toBe(true);

    const loaded = loadFindingsArtifact(paths, cwd, SESSION_ID, 1);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.findings.length).toBe(1);
      expect(loaded.value.findings[0]!.severity).toBe("BLOCKER");
    }
  });

  test("findings artifact rejects schema violations", () => {
    const invalid = {
      iteration: 0,
      draftRef: "x",
      recordedAt: "ts",
      findings: [],
    } as unknown as UltraPlanAuthoringFindingsArtifact;
    const saved = saveFindingsArtifact(paths, cwd, SESSION_ID, 1, invalid);
    expect(saved.ok).toBe(false);
  });
});

describe("authoring storage — pipeline log", () => {
  function event(overrides: Partial<UltraPlanAuthoringPipelineEvent> = {}): UltraPlanAuthoringPipelineEvent {
    return {
      recordedAt: "2026-04-30T14:00:00.000Z",
      stage: "intake",
      stageStatus: "done",
      iteration: 1,
      summary: "intake complete",
      ...overrides,
    };
  }

  test("appendPipelineLog writes a JSONL line per call", () => {
    appendPipelineLog(paths, cwd, SESSION_ID, event({ stage: "intake" }));
    appendPipelineLog(paths, cwd, SESSION_ID, event({ stage: "scout" }));

    const raw = fs.readFileSync(getUltraplanAuthoringPipelineLogPath(paths, cwd, SESSION_ID), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(2);
  });

  test("readPipelineLog parses both events", () => {
    appendPipelineLog(paths, cwd, SESSION_ID, event({ stage: "intake" }));
    appendPipelineLog(paths, cwd, SESSION_ID, event({ stage: "scout" }));

    const log = readPipelineLog(paths, cwd, SESSION_ID);
    expect(log.ok).toBe(true);
    if (log.ok) {
      expect(log.value.length).toBe(2);
      expect(log.value[0]!.stage).toBe("intake");
      expect(log.value[1]!.stage).toBe("scout");
    }
  });

  test("readPipelineLog returns empty array for missing file", () => {
    const log = readPipelineLog(paths, cwd, SESSION_ID);
    expect(log.ok).toBe(true);
    if (log.ok) expect(log.value).toEqual([]);
  });

  test("readPipelineLog skips malformed lines silently", () => {
    const filePath = getUltraplanAuthoringPipelineLogPath(paths, cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      ["{not json", JSON.stringify(event({ stage: "scout" })), ""].join("\n"),
    );

    const log = readPipelineLog(paths, cwd, SESSION_ID);
    expect(log.ok).toBe(true);
    if (log.ok) {
      expect(log.value.length).toBe(1);
      expect(log.value[0]!.stage).toBe("scout");
    }
  });

  test("appendPipelineLog rejects events that fail schema", () => {
    const bad = { ...event(), iteration: -1 } as unknown as UltraPlanAuthoringPipelineEvent;
    const result = appendPipelineLog(paths, cwd, SESSION_ID, bad);
    expect(result.ok).toBe(false);
  });
});

describe("authoring storage — workspace presence", () => {
  test("hasAuthoringWorkspace reflects directory existence", () => {
    expect(hasAuthoringWorkspace(paths, cwd, SESSION_ID)).toBe(false);

    fs.mkdirSync(getUltraplanAuthoringDir(paths, cwd, SESSION_ID), { recursive: true });
    expect(hasAuthoringWorkspace(paths, cwd, SESSION_ID)).toBe(true);
  });
});

describe("authoring storage — atomic write semantics", () => {
  test("draft authored JSON write does not leave a temp file behind", () => {
    saveDraftAuthoredJson(paths, cwd, SESSION_ID, 1, { ok: true });

    const dir = getUltraplanAuthoringDraftIterationDir(paths, cwd, SESSION_ID, 1);
    const entries = fs.readdirSync(dir);
    const tmpEntries = entries.filter((e) => e.includes(".tmp-"));
    expect(tmpEntries.length).toBe(0);
  });
});
