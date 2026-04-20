import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../../src/platform/types.js";
import type {
  UltraPlanAuthoredArtifact,
  UltraPlanManifest,
  UltraPlanProof,
  UltraPlanScenario,
  UltraPlanScenarioLevel,
  UltraPlanScenarioStatus,
  UltraPlanStack,
} from "../../src/types.js";

export function createTestPaths(rootDir: string): PlatformPaths {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) => path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) => path.join(rootDir, "global-config", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) => path.join(rootDir, "agent", ...segments),
  };
}

export function createTestRepo(rootDir: string, name = "supipowers"): { repoRoot: string; subdir: string } {
  const repoRoot = path.join(rootDir, name);
  const subdir = path.join(repoRoot, "src", "features");
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name }), "utf8");
  return { repoRoot, subdir };
}

export function makeUltraPlanProof(
  phase: "green" | "review" | "complete",
  overrides: Partial<UltraPlanProof> = {},
): UltraPlanProof {
  const type = phase === "review" ? "review" : phase === "complete" ? "artifact" : "test";

  return {
    type,
    phase,
    recordedAt: "2026-04-19T12:00:00.000Z",
    actor: "frontend-executor",
    evidence: {
      summary: `${phase} proof`,
    },
    artifactRef: `artifact://${phase}-proof`,
    ...overrides,
  };
}

function buildDefaultProofs(status: UltraPlanScenarioStatus): UltraPlanProof[] {
  switch (status) {
    case "green-proved":
      return [makeUltraPlanProof("green")];
    case "review-passed":
      return [makeUltraPlanProof("review")];
    case "done":
      return [makeUltraPlanProof("complete")];
    default:
      return [];
  }
}

export function makeUltraPlanScenario(
  id: string,
  title: string,
  status: UltraPlanScenarioStatus,
  level: UltraPlanScenarioLevel = "unit",
  overrides: Partial<UltraPlanScenario> = {},
): UltraPlanScenario {
  return {
    id,
    title,
    stack: "frontend",
    domainId: "auth",
    level,
    status,
    steps: ["do the work"],
    assignedSlots: ["frontend-executor"],
    proofs: overrides.proofs ?? buildDefaultProofs(status),
    ...overrides,
  };
}

export function makeUltraPlanStack(overrides: Partial<UltraPlanStack> = {}): UltraPlanStack {
  return {
    stack: "frontend",
    applicability: "applicable",
    domains: [
      {
        id: "auth",
        name: "Authentication",
        unit: [
          makeUltraPlanScenario("scenario-a", "First scenario", "planned"),
          makeUltraPlanScenario("scenario-b", "Second scenario", "planned"),
        ],
        integration: [],
        e2e: [],
        review: {
          enabled: true,
          status: "pending",
        },
        progress: {
          total: 2,
          terminal: 0,
          blocked: 0,
        },
      },
    ],
    status: "ready",
    agentSlots: {
      executor: {
        slot: "frontend-executor",
        agentType: "built-in",
        agentName: "frontend-executor",
        model: null,
        thinkingLevel: null,
      },
      tester: {
        slot: "frontend-tester",
        agentType: "built-in",
        agentName: "frontend-tester",
        model: null,
        thinkingLevel: null,
      },
      domainReviewEnabled: true,
      stackReviewEnabled: true,
      domainReviewer: {
        slot: "frontend-domain-reviewer",
        agentType: "built-in",
        agentName: "frontend-domain-reviewer",
        model: null,
        thinkingLevel: null,
      },
      stackReviewer: {
        slot: "frontend-stack-reviewer",
        agentType: "built-in",
        agentName: "frontend-stack-reviewer",
        model: null,
        thinkingLevel: null,
      },
    },
    progress: {
      total: 2,
      terminal: 0,
      blocked: 0,
    },
    ...overrides,
  };
}

export function makeUltraPlanAuthored(overrides: Partial<UltraPlanAuthoredArtifact> = {}): UltraPlanAuthoredArtifact {
  return {
    sessionId: "up-123",
    title: "Auth slice",
    goal: "Ship authentication",
    createdAt: "2026-04-19T12:00:00.000Z",
    updatedAt: "2026-04-19T12:00:00.000Z",
    stacks: [makeUltraPlanStack()],
    ...overrides,
  };
}

export function makeUltraPlanManifest(overrides: Partial<UltraPlanManifest> = {}): UltraPlanManifest {
  return {
    sessionId: "up-123",
    projectName: "supipowers",
    title: "Auth slice",
    authored: {
      json: "authored.json",
      markdown: "authored.md",
    },
    state: "ready",
    cursor: null,
    lastCompleted: null,
    progress: {
      total: 2,
      terminal: 0,
      blocked: 0,
    },
    stacks: [
      {
        stack: "frontend",
        applicability: "applicable",
        progress: {
          total: 2,
          terminal: 0,
          blocked: 0,
        },
        domainCount: 1,
        terminalDomainCount: 0,
      },
    ],
    blocker: null,
    reviews: [],
    createdAt: "2026-04-19T12:00:00.000Z",
    updatedAt: "2026-04-19T12:00:00.000Z",
    ...overrides,
  };
}
