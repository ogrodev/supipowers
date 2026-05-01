import { describe, expect, test } from "bun:test";

import {
  ULTRAPLAN_AUTHORING_FINDING_SEVERITIES,
  ULTRAPLAN_AUTHORING_FINDING_SOURCES,
  ULTRAPLAN_AUTHORING_PIPELINE_MODES,
  ULTRAPLAN_AUTHORING_SLOT_NAMES,
  ULTRAPLAN_AUTHORING_STAGES,
  ULTRAPLAN_AUTHORING_STAGE_STATUSES,
  validateUltraPlanAuthoringFindingsArtifact,
  validateUltraPlanAuthoringPipelineEvent,
  validateUltraPlanAuthoringState,
  validateUltraPlanManifest,
} from "../../../src/ultraplan/contracts.js";
import type {
  UltraPlanAuthoringFindingsArtifact,
  UltraPlanAuthoringPipelineEvent,
  UltraPlanAuthoringState,
} from "../../../src/types.js";
import { makeUltraPlanManifest } from "../fixtures.js";

describe("authoring contracts — exported constants are exhaustive", () => {
  test("stages constant covers every member of UltraPlanAuthoringStage", () => {
    // Smoke check: known stages must all be present.
    for (const stage of ["intake", "scout", "discover", "research", "synthesize", "review", "approve"]) {
      expect(ULTRAPLAN_AUTHORING_STAGES.includes(stage as never)).toBe(true);
    }
  });

  test("slot names constant covers every authoring slot", () => {
    for (const slot of [
      "intake",
      "scout",
      "discoverer",
      "researcher",
      "planner",
      "structure-checker",
      "scope-checker",
      "tdd-checker",
    ]) {
      expect(ULTRAPLAN_AUTHORING_SLOT_NAMES.includes(slot as never)).toBe(true);
    }
  });

  test("stage statuses, finding severities/sources, pipeline modes are populated", () => {
    expect(ULTRAPLAN_AUTHORING_STAGE_STATUSES.length).toBeGreaterThan(0);
    expect(ULTRAPLAN_AUTHORING_FINDING_SEVERITIES.length).toBe(2);
    expect(ULTRAPLAN_AUTHORING_FINDING_SOURCES.length).toBe(3);
    expect(ULTRAPLAN_AUTHORING_PIPELINE_MODES.length).toBe(2);
  });
});

describe("authoring contracts — UltraPlanAuthoringState validation", () => {
  function valid(overrides: Partial<UltraPlanAuthoringState> = {}): UltraPlanAuthoringState {
    return {
      pipeline: "multi-stage",
      stage: "synthesize",
      stageStatus: "running",
      iteration: 2,
      stallReentryCount: 0,
      artifacts: {
        intake: "authoring/intake.json",
        scout: "authoring/scout.json",
        research: [{ stack: "backend", path: "authoring/research/backend.md" }],
      },
      blocker: null,
      startedAt: "2026-04-30T12:00:00.000Z",
      updatedAt: "2026-04-30T12:00:00.000Z",
      ...overrides,
    };
  }

  test("a fully populated state passes validation", () => {
    const result = validateUltraPlanAuthoringState(valid());
    expect(result.ok).toBe(true);
  });

  test("invalid stage rejects", () => {
    const bad = { ...valid(), stage: "rumination" } as unknown;
    const result = validateUltraPlanAuthoringState(bad);
    expect(result.ok).toBe(false);
  });

  test("iteration < 1 rejects", () => {
    const result = validateUltraPlanAuthoringState(valid({ iteration: 0 }));
    expect(result.ok).toBe(false);
  });

  test("artifacts research with unknown stack rejects", () => {
    const bad = {
      ...valid(),
      artifacts: { research: [{ stack: "neither", path: "x" }] },
    } as unknown;
    const result = validateUltraPlanAuthoringState(bad);
    expect(result.ok).toBe(false);
  });

  test("additionalProperties on root rejects", () => {
    const v = { ...valid(), bogus: true } as unknown;
    const result = validateUltraPlanAuthoringState(v);
    expect(result.ok).toBe(false);
  });
});

describe("authoring contracts — manifest extension", () => {
  test("manifest without authoring still validates", () => {
    const result = validateUltraPlanManifest(makeUltraPlanManifest());
    expect(result.ok).toBe(true);
  });

  test("manifest with authoring block validates", () => {
    const manifest = {
      ...makeUltraPlanManifest(),
      authoring: {
        pipeline: "multi-stage",
        stage: "intake",
        stageStatus: "running",
        iteration: 1,
        stallReentryCount: 0,
        artifacts: {},
        blocker: null,
        startedAt: "2026-04-30T12:00:00.000Z",
        updatedAt: "2026-04-30T12:00:00.000Z",
      },
    } as Record<string, unknown>;
    const result = validateUltraPlanManifest(manifest);
    expect(result.ok).toBe(true);
  });

  test("manifest with malformed authoring block rejects", () => {
    const manifest = {
      ...makeUltraPlanManifest(),
      authoring: { pipeline: "multi-stage" },
    };
    const result = validateUltraPlanManifest(manifest as never);
    expect(result.ok).toBe(false);
  });
});

describe("authoring contracts — findings artifact", () => {
  function valid(): UltraPlanAuthoringFindingsArtifact {
    return {
      iteration: 1,
      draftRef: "drafts/iteration-1/authored.json",
      recordedAt: "2026-04-30T13:00:00.000Z",
      findings: [
        {
          id: "f1",
          severity: "WARNING",
          source: "scope-checker",
          target: { stack: null, domainId: null, scenarioId: null },
          message: "scope is wide",
          recommendation: "consider scoping down",
          recordedAt: "2026-04-30T13:00:00.000Z",
        },
      ],
    };
  }

  test("valid artifact passes", () => {
    const result = validateUltraPlanAuthoringFindingsArtifact(valid());
    expect(result.ok).toBe(true);
  });

  test("empty findings array is allowed (used for clean drafts)", () => {
    const result = validateUltraPlanAuthoringFindingsArtifact({ ...valid(), findings: [] });
    expect(result.ok).toBe(true);
  });

  test("missing recommendation on a finding rejects", () => {
    const v = valid();
    delete (v.findings[0] as unknown as Record<string, unknown>).recommendation;
    const result = validateUltraPlanAuthoringFindingsArtifact(v);
    expect(result.ok).toBe(false);
  });
});

describe("authoring contracts — pipeline event", () => {
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

  test("valid event passes", () => {
    const result = validateUltraPlanAuthoringPipelineEvent(event());
    expect(result.ok).toBe(true);
  });

  test("event with details record passes", () => {
    const result = validateUltraPlanAuthoringPipelineEvent(
      event({ details: { researcherCount: 2, model: "claude-sonnet-4-5" } }),
    );
    expect(result.ok).toBe(true);
  });

  test("non-positive iteration rejects", () => {
    const result = validateUltraPlanAuthoringPipelineEvent(event({ iteration: 0 }));
    expect(result.ok).toBe(false);
  });
});
