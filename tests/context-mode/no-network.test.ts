// tests/context-mode/no-network.test.ts
//
// Adversarial closure for Task 58: the L1 hot path \u2014 store + recorder \u2014 must
// never make outbound network calls. Two complementary assertions:
//
//   (a) globalThis.fetch shim is never invoked while we drive the full
//       end-to-end flow.
//   (b) Static import-surface check: the L1 source files do not import any
//       of the network primitives (`node:http`, `node:https`, `node:net`,
//       `node:dgram`, `node:tls`). The Node namespace bindings are frozen so
//       we can't monkey-patch them at runtime; the static check is the
//       strongest observable assurance we have without a custom loader hook.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MetricsStore,
  type MetricRow,
} from "../../src/context-mode/metrics-store.js";
import { toMetricRow } from "../../src/context-mode/metrics-recorder.js";
import { rmDirWithRetry } from "../helpers/fs.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-no-network-"));
  dbPath = path.join(tmpDir, "metrics.db");
});

afterEach(() => {
  rmDirWithRetry(tmpDir);
});

describe("L1 hot path \u2014 zero outbound network calls (Task 58)", () => {
  test("init \u2192 upsert \u2192 toMetricRow \u2192 record \u2192 prune \u2192 clear \u2192 close never invokes fetch", async () => {
    const fetchSpy = mock(() => {
      throw new Error("fetch invoked");
    });
    const origFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchSpy;

    let store: MetricsStore | null = null;
    try {
      store = new MetricsStore({ dbPath, projectSlug: "no-net" });
      store.init();
      store.upsertSession({ session_id: "s1", cwd: tmpDir });

      const row: MetricRow = toMetricRow({
        event: {
          toolName: "bash",
          input: { command: "ls" },
          content: [{ type: "text", text: "x".repeat(2048) }],
          isError: false,
        },
        compressed: { content: [{ type: "text", text: "y".repeat(256) }] },
        sessionId: "s1",
        cwd: tmpDir,
        projectSlug: "no-net",
        contextUsage: null,
        ts: Date.now(),
      });

      store.record(row);
      await store.flushPendingForTest();
      store.pruneOldSessions(7);
      store.clearSession("s1");
      store.close();
    } finally {
      (globalThis as any).fetch = origFetch;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("L1 source files do not import any node networking primitive", () => {
    const files = [
      "src/context-mode/metrics-store.ts",
      "src/context-mode/metrics-recorder.ts",
      "src/context-mode/source-hash.ts",
      "src/context-mode/tool-name.ts",
    ];
    const banned = [
      "node:http",
      "node:https",
      "node:net",
      "node:dgram",
      "node:tls",
    ];

    for (const file of files) {
      const text = fs.readFileSync(file, "utf-8");
      for (const ban of banned) {
        expect(text.includes(ban)).toBe(false);
      }
      // Sanity: also reject any literal `fetch(` call in product code.
      expect(/(^|[^a-zA-Z_])fetch\(/.test(text)).toBe(false);
    }
  });
});
