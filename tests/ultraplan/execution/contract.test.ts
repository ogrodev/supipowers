import { describe, expect, test } from "bun:test";
import type { UltraPlanAttemptContract } from "../../../src/ultraplan/execution/contract.js";
import { buildUltraPlanAttemptContract } from "../../../src/ultraplan/execution/contract.js";
import {
  LAUNCH_CONTEXT_METADATA_KEY,
  LAUNCH_CONTEXT_PROMPT_MARKER,
  TARGET_HINT_METADATA_KEY,
  TARGET_HINT_PROMPT_MARKER,
} from "../../../src/ultraplan/runtime/launch-context.js";
import {
  makeCatalogFixture,
  makeUltraPlanExecutionTarget,
  makeUltraPlanLaunchContext,
} from "../fixtures.js";

describe("ultraplan attempt contract", () => {
  test("exports the task-2 sentinel surface", () => {
    expect(buildUltraPlanAttemptContract).toBeDefined();
  });

  test("injects launch-context and target-hint carriers for a scenario attempt", () => {
    const slot = makeCatalogFixture().slots["frontend-executor"]!;
    const launchContext = makeUltraPlanLaunchContext();
    const target = makeUltraPlanExecutionTarget({
      phase: "red",
      status: "planned",
      requiredSlot: "frontend-executor",
    });

    const contract: UltraPlanAttemptContract = buildUltraPlanAttemptContract({
      slot,
      launchContext,
      target,
      prompt: "Execute exactly one ultraplan attempt.",
    });

    expect(contract.slot.slot).toBe("frontend-executor");
    expect(contract.assignment).toContain(`${LAUNCH_CONTEXT_PROMPT_MARKER}=`);
    expect(contract.assignment).toContain(`${TARGET_HINT_PROMPT_MARKER}=`);
    expect(contract.assignment).toContain("TDD ownership");
    expect(contract.assignment.toLowerCase()).toContain("no nested sub-agents");
    expect(contract.metadata[LAUNCH_CONTEXT_METADATA_KEY]).toEqual(launchContext);
    expect(contract.metadata[TARGET_HINT_METADATA_KEY]).toEqual({
      targetType: "scenario",
      stack: "frontend",
      domainId: "auth",
      level: "unit",
      scenarioId: "scenario-login-form-renders",
      phase: "red",
      resolvedSlot: "frontend-executor",
      actorKind: "slot",
      sourceAgent: "sub-agent",
    });
  });

  test("emits absolute review artifact paths and the reserved review slot", () => {
    const slot = makeCatalogFixture().slots["frontend-domain-reviewer"]!;
    const launchContext = makeUltraPlanLaunchContext();
    const target = makeUltraPlanExecutionTarget({
      targetType: "domain-review",
      level: null,
      scenarioId: null,
      phase: "review",
      status: "pending",
      summary: "frontend / auth / domain review",
      requiredSlot: "frontend-domain-reviewer",
      reviewArtifactPath: "/tmp/review/frontend/domains/auth.json",
    });

    const contract = buildUltraPlanAttemptContract({
      slot,
      launchContext,
      target,
      prompt: "Review the completed domain.",
    });

    expect(contract.slot.slot).toBe("frontend-domain-reviewer");
    expect(contract.assignment).toContain("Reserved slot: frontend-domain-reviewer");
    expect(contract.assignment).toContain("Review artifact path: /tmp/review/frontend/domains/auth.json");
  });
});
