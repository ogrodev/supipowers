import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { runPreEditProbe } from "../../../src/harness/hooks/pre-edit-dupe-probe.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { SlopBackend } from "../../../src/harness/anti_slop/backend.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-probe-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const STUB_BACKEND_CLEAN: SlopBackend = {
  id: "fallow",
  async isAvailable() {
    return true;
  },
  async dupes() {
    return { ok: true, findings: [], durationMs: 1 };
  },
  async scan() {
    return { ok: true, findings: [], durationMs: 1 };
  },
  async deadCode() {
    return { ok: true, findings: [], durationMs: 1 };
  },
  async audit() {
    return { ok: true, findings: [], durationMs: 1 };
  },
  async fix() {
    return { ok: true, appliedIds: [], failedIds: [] };
  },
};

const STUB_BACKEND_FOUND: SlopBackend = {
  id: "fallow",
  async isAvailable() {
    return true;
  },
  async dupes() {
    return {
      ok: true,
      findings: [
        {
          kind: "duplicate",
          file: "src/foo.ts",
          range: { startLine: 10, endLine: 30 },
          severity: "warning",
          source: "fallow",
          message: "near-duplicate",
        },
      ],
      durationMs: 1,
    };
  },
  async scan() {
    return { ok: true, findings: [], durationMs: 1 };
  },
  async deadCode() {
    return { ok: true, findings: [], durationMs: 1 };
  },
  async audit() {
    return { ok: true, findings: [], durationMs: 1 };
  },
  async fix() {
    return { ok: true, appliedIds: [], failedIds: [] };
  },
};

describe("runPreEditProbe", () => {
  test("min_token_count short-circuits without scanning", async () => {
    const adapter = { ...STUB_BACKEND_CLEAN, dupes: mock(STUB_BACKEND_CLEAN.dupes) };
    const result = await runPreEditProbe({
      platform: { paths, exec: mock() } as any,
      cwd,
      candidateFile: "src/x.ts",
      proposedContent: "x",
      adapter: adapter as any,
      config: { enabled: true, threshold: 0.85, min_token_count: 30 },
    });
    expect(result.block).toBe(false);
    expect(result.reason).toContain("min_token_count");
    expect((adapter.dupes as any).mock.calls.length).toBe(0);
  });

  test("clean scan → no block", async () => {
    const result = await runPreEditProbe({
      platform: { paths, exec: mock() } as any,
      cwd,
      candidateFile: "src/x.ts",
      proposedContent: "word ".repeat(50),
      adapter: STUB_BACKEND_CLEAN,
      config: { enabled: true, threshold: 0.85, min_token_count: 30 },
    });
    expect(result.block).toBe(false);
    expect(result.duplicates).toEqual([]);
  });

  test("dupe found → block: true with reason citing path:line", async () => {
    const result = await runPreEditProbe({
      platform: { paths, exec: mock() } as any,
      cwd,
      candidateFile: "src/x.ts",
      proposedContent: "word ".repeat(50),
      adapter: STUB_BACKEND_FOUND,
      config: { enabled: true, threshold: 0.85, min_token_count: 30 },
    });
    expect(result.block).toBe(true);
    expect(result.reason).toContain("src/foo.ts:10");
    expect(result.duplicates.length).toBe(1);
  });

  test("backend timeout → no block (degrades gracefully)", async () => {
    const slow: SlopBackend = {
      ...STUB_BACKEND_CLEAN,
      async dupes() {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, findings: [], durationMs: 600 }), 600);
        });
      },
    };
    const result = await runPreEditProbe({
      platform: { paths, exec: mock() } as any,
      cwd,
      candidateFile: "src/x.ts",
      proposedContent: "word ".repeat(50),
      adapter: slow,
      config: { enabled: true, threshold: 0.85, min_token_count: 30 },
      timeoutMs: 100,
    });
    expect(result.block).toBe(false);
    expect(result.reason).toContain("timeout");
  });
});
