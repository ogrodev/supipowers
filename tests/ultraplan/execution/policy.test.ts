import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UltraPlanExecutionTarget } from "../../../src/ultraplan/execution/policy.js";
import { resolveNextExecutionTarget } from "../../../src/ultraplan/execution/policy.js";
import {
  getUltraplanDomainReviewPath,
  getUltraplanStackReviewPath,
} from "../../../src/ultraplan/project-paths.js";
import type { UltraPlanReviewStatus, UltraPlanStack } from "../../../src/types.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanDomainReviewMap,
  makeUltraPlanManifest,
  makeUltraPlanScenario,
  makeUltraPlanStack,
  makeUltraPlanStackReviewMap,
} from "../fixtures.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-policy-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeAgentSlots(stack: UltraPlanStack["stack"]): UltraPlanStack["agentSlots"] {
  return {
    executor: {
      slot: `${stack}-executor`,
      agentType: "built-in",
      agentName: `${stack}-executor`,
      model: null,
      thinkingLevel: null,
    },
    tester: {
      slot: `${stack}-tester`,
      agentType: "built-in",
      agentName: `${stack}-tester`,
      model: null,
      thinkingLevel: null,
    },
    domainReviewEnabled: true,
    stackReviewEnabled: true,
    domainReviewer: {
      slot: `${stack}-domain-reviewer`,
      agentType: "built-in",
      agentName: `${stack}-domain-reviewer`,
      model: null,
      thinkingLevel: null,
    },
    stackReviewer: {
      slot: `${stack}-stack-reviewer`,
      agentType: "built-in",
      agentName: `${stack}-stack-reviewer`,
      model: null,
      thinkingLevel: null,
    },
  } as UltraPlanStack["agentSlots"];
}

function makeStackWithSingleDomain(input: {
  stack?: UltraPlanStack["stack"];
  domainId?: string;
  scenarioLevel?: "unit" | "integration" | "e2e";
  scenarioStatus?: Parameters<typeof makeUltraPlanScenario>[2];
} = {}): UltraPlanStack {
  const stack = input.stack ?? "frontend";
  const domainId = input.domainId ?? "auth";
  const scenarioLevel = input.scenarioLevel ?? "unit";
  const scenarioStatus = input.scenarioStatus ?? "planned";
  const scenario = makeUltraPlanScenario(
    `${stack}-${domainId}-${scenarioLevel}-scenario`,
    `${stack} ${domainId} ${scenarioLevel} scenario`,
    scenarioStatus,
    scenarioLevel,
    { stack, domainId },
  );

  return makeUltraPlanStack({
    stack,
    agentSlots: makeAgentSlots(stack),
    domains: [{
      id: domainId,
      name: `${domainId} domain`,
      unit: scenarioLevel === "unit" ? [scenario] : [],
      integration: scenarioLevel === "integration" ? [scenario] : [],
      e2e: scenarioLevel === "e2e" ? [scenario] : [],
      review: { enabled: true, status: "pending" },
      progress: { total: 1, terminal: 0, blocked: scenarioStatus === "blocked" ? 1 : 0 },
    }],
    progress: { total: 1, terminal: 0, blocked: scenarioStatus === "blocked" ? 1 : 0 },
  });
}

function resolveForStacks(input: {
  stacks: UltraPlanStack[];
  domainReviews?: Partial<Record<UltraPlanStack["stack"], Record<string, UltraPlanReviewStatus>>>;
  stackReviews?: Partial<Record<UltraPlanStack["stack"], UltraPlanReviewStatus>>;
}): {
  target: UltraPlanExecutionTarget;
  cwd: string;
  paths: ReturnType<typeof createTestPaths>;
  authored: ReturnType<typeof makeUltraPlanAuthored>;
} {
  const paths = createTestPaths(tmpDir);
  const { repoRoot: cwd } = createTestRepo(tmpDir);
  const authored = makeUltraPlanAuthored({ stacks: input.stacks });
  const manifest = makeUltraPlanManifest({ sessionId: authored.sessionId, reviews: [] });

  return {
    target: resolveNextExecutionTarget({
      paths,
      cwd,
      authored,
      manifest,
      reviews: {
        domainReviews: makeUltraPlanDomainReviewMap(input.domainReviews ?? {}),
        stackReviews: makeUltraPlanStackReviewMap(input.stackReviews ?? {}),
      },
    }),
    cwd,
    paths,
    authored,
  };
}

describe("ultraplan execution policy", () => {
  test("exports the task-1 sentinel surface", () => {
    expect(resolveNextExecutionTarget).toBeDefined();
  });

  for (const testCase of [
    {
      name: "unit planned -> executor red",
      stack: makeStackWithSingleDomain({ scenarioLevel: "unit", scenarioStatus: "planned" }),
      expectedSlot: "frontend-executor",
      expectedPhase: "red",
      expectedStatus: "planned",
    },
    {
      name: "unit red-proved -> executor green",
      stack: makeStackWithSingleDomain({ scenarioLevel: "unit", scenarioStatus: "red-proved" }),
      expectedSlot: "frontend-executor",
      expectedPhase: "green",
      expectedStatus: "red-proved",
    },
    {
      name: "integration planned -> tester red",
      stack: makeStackWithSingleDomain({ scenarioLevel: "integration", scenarioStatus: "planned" }),
      expectedSlot: "frontend-tester",
      expectedPhase: "red",
      expectedStatus: "planned",
    },
    {
      name: "integration red-proved -> executor green",
      stack: makeStackWithSingleDomain({ scenarioLevel: "integration", scenarioStatus: "red-proved" }),
      expectedSlot: "frontend-executor",
      expectedPhase: "green",
      expectedStatus: "red-proved",
    },
    {
      name: "e2e planned -> tester red",
      stack: makeStackWithSingleDomain({ scenarioLevel: "e2e", scenarioStatus: "planned" }),
      expectedSlot: "frontend-tester",
      expectedPhase: "red",
      expectedStatus: "planned",
    },
    {
      name: "e2e red-proved -> executor green",
      stack: makeStackWithSingleDomain({ scenarioLevel: "e2e", scenarioStatus: "red-proved" }),
      expectedSlot: "frontend-executor",
      expectedPhase: "green",
      expectedStatus: "red-proved",
    },
  ] as const) {
    test(testCase.name, () => {
      const { target } = resolveForStacks({ stacks: [testCase.stack] });

      expect(target.targetType).toBe("scenario");
      expect(target.requiredSlot).toBe(testCase.expectedSlot);
      expect(target.phase).toBe(testCase.expectedPhase);
      expect(target.status).toBe(testCase.expectedStatus);
      expect(target.reviewArtifactPath).toBeNull();
    });
  }

  test("domain-review becomes eligible after terminal scenarios", () => {
    const stack = makeStackWithSingleDomain({ scenarioLevel: "unit", scenarioStatus: "green-proved" });
    const { target, cwd, paths, authored } = resolveForStacks({ stacks: [stack] });

    expect(target.targetType).toBe("domain-review");
    expect(target.requiredSlot).toBe("frontend-domain-reviewer");
    expect(target.phase).toBe("review");
    expect(target.status).toBe("pending");
    expect(target.reviewArtifactPath).toBe(
      getUltraplanDomainReviewPath(paths, cwd, authored.sessionId, "frontend", "auth"),
    );
  });

  test("stack-review becomes eligible after passed domain reviews", () => {
    const stack = makeStackWithSingleDomain({ scenarioLevel: "unit", scenarioStatus: "green-proved" });
    const { target, cwd, paths, authored } = resolveForStacks({
      stacks: [stack],
      domainReviews: { frontend: { auth: "passed" } },
    });

    expect(target.targetType).toBe("stack-review");
    expect(target.requiredSlot).toBe("frontend-stack-reviewer");
    expect(target.phase).toBe("review");
    expect(target.status).toBe("pending");
    expect(target.reviewArtifactPath).toBe(getUltraplanStackReviewPath(paths, cwd, authored.sessionId, "frontend"));
  });

  test("returns a session-complete target when all reviews are passed", () => {
    const stack = makeStackWithSingleDomain({ scenarioLevel: "unit", scenarioStatus: "green-proved" });
    const { target } = resolveForStacks({
      stacks: [stack],
      domainReviews: { frontend: { auth: "passed" } },
      stackReviews: { frontend: "passed" },
    });

    expect(target.targetType).toBe("session");
    expect(target.phase).toBe("complete");
    expect(target.status).toBe("complete");
    expect(target.requiredSlot).toBeNull();
    expect(target.reviewArtifactPath).toBeNull();
  });

  test("reused domain ids across different stacks do not collide", () => {
    const frontend = makeStackWithSingleDomain({ stack: "frontend", domainId: "shared", scenarioStatus: "green-proved" });
    const backend = makeStackWithSingleDomain({ stack: "backend", domainId: "shared", scenarioLevel: "integration", scenarioStatus: "planned" });
    const { target } = resolveForStacks({
      stacks: [frontend, backend],
      domainReviews: { frontend: { shared: "passed" }, backend: { shared: "pending" } },
      stackReviews: { frontend: "passed" },
    });

    expect(target.targetType).toBe("scenario");
    expect(target.stack).toBe("backend");
    expect(target.domainId).toBe("shared");
    expect(target.requiredSlot).toBe("backend-tester");
    expect(target.phase).toBe("red");
  });
});
