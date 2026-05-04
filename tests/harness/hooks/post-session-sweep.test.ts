import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runPostSessionSweep } from "../../../src/harness/hooks/post-session-sweep.js";
import { readSlopQueue } from "../../../src/harness/storage.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { SlopBackend } from "../../../src/harness/anti_slop/backend.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-sweep-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const FOUND_BACKEND: SlopBackend = {
  id: "fallow",
  async isAvailable() {
    return true;
  },
  async deadCode() {
    return {
      ok: true,
      findings: [
        {
          kind: "dead-code",
          file: "src/unused.ts",
          range: { startLine: 1, endLine: 5 },
          severity: "warning",
          source: "fallow",
          message: "unused export `foo`",
        },
      ],
      durationMs: 1,
    };
  },
  async scan() {
    return { ok: true, findings: [], durationMs: 1 };
  },
  async dupes() {
    return { ok: true, findings: [], durationMs: 1 };
  },
  async audit() {
    return { ok: true, findings: [], durationMs: 1 };
  },
  async fix() {
    return { ok: true, appliedIds: [], failedIds: [] };
  },
};

describe("runPostSessionSweep", () => {
  test("appends findings to the queue", async () => {
    const result = await runPostSessionSweep({
      platform: { paths, exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }) } as any,
      cwd,
      adapter: FOUND_BACKEND,
      timeoutMs: 1000,
    });
    expect(result.ran).toBe(true);
    expect(result.newFindings).toBe(1);
    const queue = readSlopQueue(paths, cwd);
    if (queue.ok) {
      expect(queue.value.length).toBe(1);
      expect(queue.value[0].file).toBe("src/unused.ts");
    }
  });

  test("backend unavailable → ran: false, no findings appended", async () => {
    const unavailable: SlopBackend = {
      ...FOUND_BACKEND,
      async deadCode() {
        return { ok: false, reason: "not-installed", message: "no fallow" };
      },
    };
    const result = await runPostSessionSweep({
      platform: { paths, exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }) } as any,
      cwd,
      adapter: unavailable,
      timeoutMs: 1000,
    });
    expect(result.ran).toBe(false);
    expect(result.newFindings).toBe(0);
  });
});
