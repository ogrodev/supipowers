import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UltraPlanIndex, UltraPlanManifest } from "../../src/types.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanDomainReviewPath,
  getUltraplanIndexPath,
  getUltraplanManifestPath,
  getUltraplanStackReviewPath,
} from "../../src/ultraplan/project-paths.js";
import {
  loadUltraPlanAuthoredArtifact,
  loadUltraPlanDomainReview,
  loadUltraPlanIndex,
  loadUltraPlanManifest,
  loadUltraPlanSessionSummary,
  loadUltraPlanStackReview,
  saveUltraPlanAuthoredArtifact,
  saveUltraPlanIndex,
  saveUltraPlanManifest,
} from "../../src/ultraplan/storage.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanManifest,
  makeUltraPlanScenario,
  makeUltraPlanStack,
} from "./fixtures.js";

let tmpDir: string;

const authored = makeUltraPlanAuthored({
  title: "Build authentication slice",
  goal: "Deliver the first auth flow across frontend and backend",
  stacks: [makeUltraPlanStack({
    domains: [
      {
        id: "auth",
        name: "Authentication",
        unit: [
          makeUltraPlanScenario(
            "scenario-login-form-renders",
            "Login form renders required fields",
            "planned",
            "unit",
            { steps: ["write failing test", "implement fields"] },
          ),
        ],
        integration: [],
        e2e: [],
        review: {
          enabled: true,
          status: "pending",
        },
        progress: {
          total: 1,
          terminal: 0,
          blocked: 0,
        },
      },
    ],
    progress: {
      total: 1,
      terminal: 0,
      blocked: 0,
    },
  })],
});

const manifest = makeUltraPlanManifest({
  title: "Build authentication slice",
  cursor: {
    targetType: "scenario",
    stack: "frontend",
    domainId: "auth",
    level: "unit",
    scenarioId: "scenario-login-form-renders",
    phase: "red",
    status: "planned",
    summary: "frontend / auth / unit / Login form renders required fields",
  },
  progress: {
    total: 1,
    terminal: 0,
    blocked: 0,
  },
  stacks: [
    {
      stack: "frontend",
      applicability: "applicable",
      progress: {
        total: 1,
        terminal: 0,
        blocked: 0,
      },
      domainCount: 1,
      terminalDomainCount: 0,
    },
  ],
  reviews: [
    {
      type: "domain",
      stack: "frontend",
      domainId: "auth",
      path: "review/frontend/domains/auth.json",
      status: "pending",
    },
    {
      type: "stack",
      stack: "frontend",
      domainId: null,
      path: "review/frontend/stack.json",
      status: "pending",
    },
  ],
  updatedAt: "2026-04-19T12:15:00.000Z",
}) satisfies UltraPlanManifest;

const index = {
  sessions: [
    {
      sessionId: "up-123",
      title: "Build authentication slice",
      state: "ready",
      bucket: "pending",
      createdAt: "2026-04-19T12:00:00.000Z",
      updatedAt: "2026-04-19T12:15:00.000Z",
      cursor: manifest.cursor,
      idleReason: null,
    },
  ],
} satisfies UltraPlanIndex;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-storage-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ultraplan storage", () => {
  test("reports a missing index instead of inventing an empty session list", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;

    expect(loadUltraPlanIndex(paths, cwd)).toEqual({
      ok: false,
      error: {
        kind: "missing",
        path: getUltraplanIndexPath(paths, cwd),
        message: `Artifact not found: ${getUltraplanIndexPath(paths, cwd)}`,
      },
    });
  });


  test("creates the ultraplan root lazily and round-trips index, manifest, and authored artifacts", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;

    const saveIndexResult = saveUltraPlanIndex(paths, cwd, index);
    expect(saveIndexResult.ok).toBe(true);
    expect(fs.existsSync(saveIndexResult.ok ? saveIndexResult.value : "")).toBe(true);

    const loadedIndex = loadUltraPlanIndex(paths, cwd);
    expect(loadedIndex).toEqual({ ok: true, value: index });

    const saveManifestResult = saveUltraPlanManifest(paths, cwd, manifest.sessionId, manifest);
    expect(saveManifestResult.ok).toBe(true);
    const saveAuthoredResult = saveUltraPlanAuthoredArtifact(paths, cwd, authored.sessionId, authored);
    expect(saveAuthoredResult.ok).toBe(true);

    expect(loadUltraPlanManifest(paths, cwd, manifest.sessionId)).toEqual({ ok: true, value: manifest });
    expect(loadUltraPlanAuthoredArtifact(paths, cwd, authored.sessionId)).toEqual({ ok: true, value: authored });
  });

  test("rejects invalid manifest and authored payloads instead of trusting raw json", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;

    fs.mkdirSync(path.dirname(getUltraplanManifestPath(paths, cwd, manifest.sessionId)), { recursive: true });
    fs.writeFileSync(getUltraplanManifestPath(paths, cwd, manifest.sessionId), "{not-json");
    expect(loadUltraPlanManifest(paths, cwd, manifest.sessionId)).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-json",
      },
    });

    fs.mkdirSync(path.dirname(getUltraplanAuthoredJsonPath(paths, cwd, authored.sessionId)), { recursive: true });
    fs.writeFileSync(
      getUltraplanAuthoredJsonPath(paths, cwd, authored.sessionId),
      JSON.stringify({ sessionId: authored.sessionId, title: authored.title }),
    );
    expect(loadUltraPlanAuthoredArtifact(paths, cwd, authored.sessionId)).toMatchObject({
      ok: false,
      error: {
        kind: "validation-error",
      },
    });
  });

  test("reads a normalized session summary from a valid session directory", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;

    saveUltraPlanManifest(paths, cwd, manifest.sessionId, manifest);
    saveUltraPlanAuthoredArtifact(paths, cwd, authored.sessionId, authored);

    expect(loadUltraPlanSessionSummary(paths, cwd, manifest.sessionId)).toEqual({
      ok: true,
      value: {
        sessionId: manifest.sessionId,
        projectName: manifest.projectName,
        title: manifest.title,
        state: manifest.state,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        cursor: manifest.cursor,
        lastCompleted: manifest.lastCompleted,
        blocker: manifest.blocker,
        progress: manifest.progress,
        stacks: manifest.stacks,
        reviews: manifest.reviews,
      },
    });
  });
  test("requires a validated review artifact before honoring a passed review summary", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const passedManifest = {
      ...manifest,
      reviews: manifest.reviews.map((review) => ({ ...review, status: "passed" as const })),
    } satisfies UltraPlanManifest;

    saveUltraPlanManifest(paths, cwd, passedManifest.sessionId, passedManifest);
    saveUltraPlanAuthoredArtifact(paths, cwd, authored.sessionId, authored);

    expect(loadUltraPlanSessionSummary(paths, cwd, passedManifest.sessionId)).toMatchObject({
      ok: false,
      error: {
        kind: "missing",
        path: getUltraplanDomainReviewPath(paths, cwd, passedManifest.sessionId, "frontend", "auth"),
      },
    });
  });

  test("loads a passed review summary only when the referenced review artifacts validate", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const passedManifest = {
      ...manifest,
      reviews: manifest.reviews.map((review) => ({ ...review, status: "passed" as const })),
    } satisfies UltraPlanManifest;

    saveUltraPlanManifest(paths, cwd, passedManifest.sessionId, passedManifest);
    saveUltraPlanAuthoredArtifact(paths, cwd, authored.sessionId, authored);

    fs.mkdirSync(path.dirname(getUltraplanDomainReviewPath(paths, cwd, passedManifest.sessionId, "frontend", "auth")), { recursive: true });
    fs.writeFileSync(
      getUltraplanDomainReviewPath(paths, cwd, passedManifest.sessionId, "frontend", "auth"),
      JSON.stringify({
        stack: "frontend",
        domainId: "auth",
        reviewerSlot: "frontend-domain-reviewer",
        status: "passed",
        startedAt: "2026-04-19T12:10:00.000Z",
        completedAt: "2026-04-19T12:12:00.000Z",
        summary: "Domain review passed",
        artifactRef: "artifact://domain-review-auth",
      }),
    );
    fs.mkdirSync(path.dirname(getUltraplanStackReviewPath(paths, cwd, passedManifest.sessionId, "frontend")), { recursive: true });
    fs.writeFileSync(
      getUltraplanStackReviewPath(paths, cwd, passedManifest.sessionId, "frontend"),
      JSON.stringify({
        stack: "frontend",
        reviewerSlot: "frontend-stack-reviewer",
        status: "passed",
        startedAt: "2026-04-19T12:13:00.000Z",
        completedAt: "2026-04-19T12:15:00.000Z",
        summary: "Stack review passed",
        artifactRef: "artifact://stack-review-frontend",
      }),
    );

    expect(loadUltraPlanSessionSummary(paths, cwd, passedManifest.sessionId)).toMatchObject({
      ok: true,
      value: {
        sessionId: passedManifest.sessionId,
        reviews: passedManifest.reviews,
      },
    });
  });



  test("gracefully handles missing optional review artifacts", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;

    expect(loadUltraPlanDomainReview(paths, cwd, manifest.sessionId, "frontend", "auth")).toEqual({ ok: true, value: null });
    expect(loadUltraPlanStackReview(paths, cwd, manifest.sessionId, "frontend")).toEqual({ ok: true, value: null });

    fs.mkdirSync(path.dirname(getUltraplanDomainReviewPath(paths, cwd, manifest.sessionId, "frontend", "auth")), { recursive: true });
    fs.writeFileSync(
      getUltraplanDomainReviewPath(paths, cwd, manifest.sessionId, "frontend", "auth"),
      JSON.stringify({ stack: "frontend", domainId: "auth" }),
    );
    expect(loadUltraPlanDomainReview(paths, cwd, manifest.sessionId, "frontend", "auth")).toMatchObject({
      ok: false,
      error: {
        kind: "validation-error",
      },
    });

    fs.mkdirSync(path.dirname(getUltraplanStackReviewPath(paths, cwd, manifest.sessionId, "frontend")), { recursive: true });
    fs.writeFileSync(
      getUltraplanStackReviewPath(paths, cwd, manifest.sessionId, "frontend"),
      JSON.stringify({ stack: "frontend" }),
    );
    expect(loadUltraPlanStackReview(paths, cwd, manifest.sessionId, "frontend")).toMatchObject({
      ok: false,
      error: {
        kind: "validation-error",
      },
    });
  });
});
