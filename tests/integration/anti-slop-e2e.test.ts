/**
 * End-to-end test for the anti-slop layer.
 *
 * Exercises the full data-flow without spinning up a real LLM session:
 *  1. Record a duplicate finding via the pre-edit probe → queue receives it.
 *  2. Record a dead-code finding via the post-session sweep → queue receives it.
 *  3. Run GC against the queue → mechanical entry resolves; judgmental remains.
 *  4. Score recomputes and reflects the new state.
 *
 * The test intentionally bypasses the `before-/after-/file-resolver` glue and instead
 * calls the deterministic pure functions (`runPreEditProbe`, `runPostSessionSweep`,
 * `runHarnessGc`, `computeScore`). The platform layer is mocked. This is what an integration
 * eval that survives no-LLM CI runs looks like.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { computeScore } from "../../src/harness/anti_slop/score.js";
import { runPostSessionSweep } from "../../src/harness/hooks/post-session-sweep.js";
import { runPreEditProbe } from "../../src/harness/hooks/pre-edit-dupe-probe.js";
import { runHarnessGc } from "../../src/harness/gc/runner.js";
import { readAll } from "../../src/harness/anti_slop/queue.js";
import { writeMarker } from "../../src/harness/bare-entry.js";
import { createTestPaths, createTestRepo } from "../ultraplan/fixtures.js";
import type { SlopBackend } from "../../src/harness/anti_slop/backend.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-e2e-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
  // Install the harness marker so hooks are gate-allowed.
  writeMarker(paths, cwd, { installedAt: "2026-05-03T12:00:00.000Z", backend: "fallow" });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const DUP_BACKEND: SlopBackend = {
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
          message: "near-duplicate of src/bar.ts:42",
        },
      ],
      durationMs: 1,
    };
  },
  async scan() {
    return { ok: true, findings: [], durationMs: 1 };
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
          message: "unused export `dead`",
        },
      ],
      durationMs: 1,
    };
  },
  async audit() {
    return { ok: true, findings: [], durationMs: 1 };
  },
  async fix(_p, opts) {
    return { ok: true, appliedIds: opts.entryIds ?? [], failedIds: [] };
  },
};

describe("anti-slop e2e", () => {
  test("probe → block → queue; sweep → queue; gc → mechanical resolves", async () => {
    const platform = { paths, exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }) } as any;

    // Step 1: pre-edit probe records the duplicate and blocks.
    const probe = await runPreEditProbe({
      platform,
      cwd,
      candidateFile: "src/foo.ts",
      proposedContent: "word ".repeat(50),
      adapter: DUP_BACKEND,
      config: { enabled: true, threshold: 0.85, min_token_count: 30 },
    });
    expect(probe.block).toBe(true);

    // Step 2: post-session sweep records the dead-code finding.
    const sweep = await runPostSessionSweep({
      platform,
      cwd,
      adapter: DUP_BACKEND,
      timeoutMs: 1000,
    });
    expect(sweep.ran).toBe(true);
    expect(sweep.newFindings).toBe(1);

    // Verify the queue has both entries.
    const before = readAll(paths, cwd);
    expect(before.ok).toBe(true);
    if (before.ok) {
      const open = before.value.filter((e) => e.state === "open");
      expect(open.length).toBe(2);
      expect(open.find((e) => e.kind === "duplicate")).toBeDefined();
      expect(open.find((e) => e.kind === "dead-code")).toBeDefined();
    }

    // Step 3: run GC. Mechanical (dead-code) resolves; judgmental (duplicate) remains.
    const gcReport = await runHarnessGc({
      platform,
      paths,
      cwd,
      backend: "fallow",
      adapter: DUP_BACKEND,
      apply: true,
    });
    expect(gcReport.inspected).toBe(2);
    expect(gcReport.judgmentalReported).toBe(1);
    expect(gcReport.mechanicalResolved).toBe(1);

    // Step 4: score reflects the new state.
    const after = readAll(paths, cwd);
    if (after.ok) {
      const open = after.value.filter((e) => e.state === "open");
      const resolved = after.value.filter((e) => e.state === "resolved");
      expect(open.length).toBe(1); // duplicate still open
      expect(resolved.length).toBe(1); // dead-code resolved
      const score = computeScore({ computedAt: "2026-05-03T12:00:00.000Z", entries: after.value });
      // Strict score should be < 100 because there's still an open duplicate.
      expect(score.strict).toBeLessThan(100);
    }
  });
});
