/**
 * Diary round-trip integration test.
 *
 * Verifies that a `diary_write` call with a `source_file` param results in an
 * entry whose text content carries the "[source: <source_file>]" prefix, as
 * embedded by the Python bridge's `_diary_write_extractor`.
 *
 * This test exercises the real installed MemPalace package and is skipped
 * (not failed) when the managed venv is absent.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, expect } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults.js";
import { snapshotMempalaceInstall } from "../../../src/mempalace/installer-helper.js";
import { createMempalaceBridge } from "../../../src/mempalace/bridge.js";
import { resolveMempalaceConfig } from "../../../src/mempalace/config.js";
import { resolveManagedVenvPaths, resolveBridgeScriptPath, runBridgeRequest } from "../../../src/mempalace/runtime.js";
import { createPaths } from "../../../src/platform/types.js";

describe("diary round-trip integration", () => {
  test("diary_write source_file prefix survives to diary_read content", async () => {
    const paths = createPaths(".omp");
    const snapshot = snapshotMempalaceInstall(paths, process.cwd());

    if (!snapshot.ready) {
      console.warn(
        "Skipping diary round-trip test: managed MemPalace venv is not installed " +
          `(venvInstalled=${snapshot.venvInstalled}, uvInstalled=${snapshot.uvInstalled}, ` +
          `bridgeOk=${snapshot.bridgeOk}). Run /supi:memory setup to install.`,
      );
      return;
    }

    // Use a temp palace so the test never pollutes the real user palace.
    const tmpPalace = fs.mkdtempSync(path.join(os.tmpdir(), "supi-diary-rt-"));
    try {
      const config = resolveMempalaceConfig(DEFAULT_CONFIG, process.cwd(), paths);
      const venv = resolveManagedVenvPaths(config.managedVenvPath);
      const bridgePath = resolveBridgeScriptPath();
      if (!bridgePath.ok) {
        throw new Error(`Bridge not found: ${bridgePath.error.message}`);
      }

      const agentName = "omp-test";
      const uniqueId = `test-session:rt-${Date.now()}:shutdown:2026-05-13T00:00:00.000Z`;
      const entryBody = `Round-trip test entry written at ${new Date().toISOString()}`;

      // 1. Write a diary entry with source_file.
      const writeResult = await runBridgeRequest({
        pythonPath: venv.python,
        bridgeScriptPath: bridgePath.path,
        timeoutMs: 15_000,
        request: {
          action: "diary_write",
          params: {
            agent_name: agentName,
            entry: entryBody,
            topic: "shutdown",
            wing: "supipowers",
            source_file: uniqueId,
          },
          options: { palacePath: tmpPalace },
        },
      });

      expect(writeResult.ok).toBe(true);
      if (!writeResult.ok) throw new Error(`write bridge failed: ${writeResult.error.message}`);
      expect(writeResult.response.ok).toBe(true);
      if (!writeResult.response.ok) {
        throw new Error(`tool_diary_write failed: ${writeResult.response.error.message}`);
      }

      // 2. Read back and verify the source_file prefix is present.
      const readResult = await runBridgeRequest({
        pythonPath: venv.python,
        bridgeScriptPath: bridgePath.path,
        timeoutMs: 15_000,
        request: {
          action: "diary_read",
          params: { agent_name: agentName, wing: "supipowers" },
          options: { palacePath: tmpPalace },
        },
      });

      expect(readResult.ok).toBe(true);
      if (!readResult.ok) throw new Error(`read bridge failed: ${readResult.error.message}`);
      expect(readResult.response.ok).toBe(true);
      if (!readResult.response.ok) {
        throw new Error(`tool_diary_read failed: ${readResult.response.error.message}`);
      }

      const responseResult = readResult.response.result as {
        entries?: Array<{ content: string; topic: string }>;
      };
      const entries = responseResult.entries ?? [];
      expect(entries.length).toBeGreaterThan(0);

      // The entry content must carry the [source: <uniqueId>] prefix.
      const found = entries.find((e) => e.content.includes(`[source: ${uniqueId}]`));
      expect(found).toBeDefined();
      if (!found) {
        throw new Error(
          `No entry with source prefix "[source: ${uniqueId}]" found. ` +
            `Got entries: ${JSON.stringify(entries.map((e) => e.content.slice(0, 120)))}`,
        );
      }
      expect(found.content).toContain(entryBody);
    } finally {
      fs.rmSync(tmpPalace, { recursive: true, force: true });
    }
  });
});
