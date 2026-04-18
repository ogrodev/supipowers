
import {
  generateFixPrSessionId,
  createFixPrSession,
  loadFixPrSession,
  updateFixPrSession,
  findActiveFixPrSession,
  getSessionDir,
} from "../../src/storage/fix-pr-sessions.js";
import type { FixPrSessionLedger } from "../../src/fix-pr/types.js";
import { DEFAULT_FIX_PR_CONFIG } from "../../src/fix-pr/config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createPaths } from "../../src/platform/types.js";
import type { WorkspaceTarget } from "../../src/types.js";

const paths = createPaths(".omp");

function target(repoRoot: string, relativeDir = "."): WorkspaceTarget {
  return {
    id: relativeDir === "." ? "repo-root" : `pkg:${relativeDir}`,
    name: relativeDir === "." ? "repo-root" : `pkg:${relativeDir}`,
    kind: relativeDir === "." ? "root" : "workspace",
    repoRoot,
    packageDir: relativeDir === "." ? repoRoot : path.join(repoRoot, relativeDir),
    manifestPath: relativeDir === "." ? path.join(repoRoot, "package.json") : path.join(repoRoot, relativeDir, "package.json"),
    relativeDir,
    version: "1.0.0",
    private: false,
    packageManager: "bun",
  };
}
function makeLedger(overrides?: Partial<FixPrSessionLedger>): FixPrSessionLedger {
  return {
    id: generateFixPrSessionId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prNumber: 42,
    repo: "owner/repo",
    status: "running",
    iteration: 0,
    config: DEFAULT_FIX_PR_CONFIG,
    commentsProcessed: [],
    ...overrides,
  };
}

describe("generateFixPrSessionId", () => {
  test("starts with fpr-", () => {
    const id = generateFixPrSessionId();
    expect(id.startsWith("fpr-")).toBe(true);
  });

  test("generates unique IDs", () => {
    const a = generateFixPrSessionId();
    const b = generateFixPrSessionId();
    expect(a).not.toBe(b);
  });

  test("matches expected format fpr-YYYYMMDD-HHMMSS-xxxx", () => {
    const id = generateFixPrSessionId();
    expect(id).toMatch(/^fpr-\d{8}-\d{6}-[a-z0-9]{4}$/);
  });
});

describe("session CRUD", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-fpr-sess-"));
    return tmpDir;
  }

  function cleanup() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  test("createFixPrSession creates session directory and ledger", () => {
    setup();
    const workspaceTarget = target(tmpDir);
    const ledger = makeLedger();
    createFixPrSession(paths, workspaceTarget, ledger);
    const sessionDir = getSessionDir(paths, workspaceTarget, ledger.id);
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "ledger.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "snapshots"))).toBe(true);
    cleanup();
  });

  test("loadFixPrSession reads ledger back", () => {
    setup();
    const workspaceTarget = target(tmpDir);
    const ledger = makeLedger();
    createFixPrSession(paths, workspaceTarget, ledger);
    const loaded = loadFixPrSession(paths, workspaceTarget, ledger.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.prNumber).toBe(42);
    expect(loaded!.repo).toBe("owner/repo");
    cleanup();
  });

  test("loadFixPrSession returns null for missing session", () => {
    setup();
    const workspaceTarget = target(tmpDir);
    const loaded = loadFixPrSession(paths, workspaceTarget, "fpr-nonexistent");
    expect(loaded).toBeNull();
    cleanup();
  });

  test("updateFixPrSession overwrites ledger", () => {
    setup();
    const workspaceTarget = target(tmpDir);
    const ledger = makeLedger();
    createFixPrSession(paths, workspaceTarget, ledger);
    ledger.iteration = 2;
    ledger.commentsProcessed = [1, 2, 3];
    updateFixPrSession(paths, workspaceTarget, ledger);
    const loaded = loadFixPrSession(paths, workspaceTarget, ledger.id);
    expect(loaded!.iteration).toBe(2);
    expect(loaded!.commentsProcessed).toEqual([1, 2, 3]);
    cleanup();
  });

  test("findActiveFixPrSession finds newest running session for the same PR", () => {
    setup();
    const workspaceTarget = target(tmpDir);
    const older = makeLedger({
      id: "fpr-20260312-143000-a1b2",
      status: "running",
      repo: "owner/repo",
      prNumber: 42,
    });
    const newer = makeLedger({
      id: "fpr-20260312-143001-c3d4",
      status: "running",
      repo: "owner/repo",
      prNumber: 42,
    });
    createFixPrSession(paths, workspaceTarget, older);
    createFixPrSession(paths, workspaceTarget, newer);
    const found = findActiveFixPrSession(paths, workspaceTarget, "owner/repo", 42);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(newer.id);
    cleanup();
  });

  test("findActiveFixPrSession ignores running sessions for a different PR or repo", () => {
    setup();
    const workspaceTarget = target(tmpDir);
    createFixPrSession(paths, workspaceTarget, makeLedger({
      id: "fpr-20260312-143000-a1b2",
      status: "running",
      repo: "owner/repo",
      prNumber: 99,
    }));
    createFixPrSession(paths, workspaceTarget, makeLedger({
      id: "fpr-20260312-143001-c3d4",
      status: "running",
      repo: "other/repo",
      prNumber: 42,
    }));
    const found = findActiveFixPrSession(paths, workspaceTarget, "owner/repo", 42);
    expect(found).toBeNull();
    cleanup();
  });

  test("findActiveFixPrSession returns null when no matching running sessions exist", () => {
    setup();
    const workspaceTarget = target(tmpDir);
    const ledger = makeLedger({ status: "completed" });
    createFixPrSession(paths, workspaceTarget, ledger);
    const found = findActiveFixPrSession(paths, workspaceTarget, "owner/repo", 42);
    expect(found).toBeNull();
    cleanup();
  });

  test("findActiveFixPrSession returns null when there are no sessions", () => {
    setup();
    const workspaceTarget = target(tmpDir);
    const found = findActiveFixPrSession(paths, workspaceTarget, "owner/repo", 42);
    expect(found).toBeNull();
    cleanup();
  });

  test("getSessionDir returns correct path", () => {
    setup();
    const dir = getSessionDir(paths, target(tmpDir, "packages/pkg-a"), "fpr-20260312-143000-a1b2");
    expect(dir).toContain("workspaces");
    expect(dir).toContain("fix-pr-sessions");
    expect(dir).toContain(path.join("packages", "pkg-a"));
    expect(dir).toContain("fpr-20260312-143000-a1b2");
    cleanup();
  });
});
