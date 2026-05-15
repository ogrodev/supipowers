import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  FallowAdapter,
  _resetFallowAvailabilityCacheForTests,
} from "../../../src/harness/anti_slop/fallow-adapter.js";
import { normalizeExecCall } from "../../helpers/exec-calls.js";

beforeEach(() => {
  _resetFallowAvailabilityCacheForTests();
});

afterEach(() => {
  _resetFallowAvailabilityCacheForTests();
});

function makePlatform(handler: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>) {
  // execCli rewrites npx → `node <path>/npx-cli.js` on Windows; normalize so
  // adapter tests can keep matching on the logical command name.
  return {
    exec: mock(async (cmdRaw: string, argsRaw: string[]) => {
      const { cmd, args } = normalizeExecCall({ cmd: cmdRaw, args: argsRaw });
      return handler(cmd, args);
    }),
    paths: {} as any,
  } as any;
}

describe("FallowAdapter availability", () => {
  test("native binary present → ok", async () => {
    const platform = makePlatform(async (cmd) => {
      if (cmd === "fallow") return { stdout: "fallow 1.2.3", stderr: "", code: 0 };
      return { stdout: "", stderr: "not found", code: 127 };
    });
    const adapter = new FallowAdapter();
    expect(await adapter.isAvailable(platform)).toBe(true);
  });

  test("falls back to npx when binary missing", async () => {
    const platform = makePlatform(async (cmd, args) => {
      if (cmd === "fallow") return { stdout: "", stderr: "no fallow", code: 127 };
      if (cmd === "npx" && args.includes("fallow")) return { stdout: "fallow 1.2.3", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 127 };
    });
    const adapter = new FallowAdapter();
    expect(await adapter.isAvailable(platform)).toBe(true);
  });

  test("not installed → false", async () => {
    const platform = makePlatform(async () => ({ stdout: "", stderr: "no", code: 127 }));
    const adapter = new FallowAdapter();
    expect(await adapter.isAvailable(platform)).toBe(false);
  });
});

describe("FallowAdapter scan", () => {
  test("parses JSON output and maps kinds", async () => {
    const findings = {
      version: "1.2.3",
      findings: [
        {
          kind: "duplicate",
          file: "src/foo.ts",
          startLine: 10,
          endLine: 30,
          severity: "warning",
          message: "near-duplicate of src/bar.ts:42",
          partner: { file: "src/bar.ts", startLine: 42, endLine: 60 },
        },
      ],
    };
    const platform = makePlatform(async (cmd, args) => {
      if (cmd === "fallow" && args[0] === "--version") return { stdout: "1.2.3", stderr: "", code: 0 };
      return { stdout: JSON.stringify(findings), stderr: "", code: 1 };
    });
    const adapter = new FallowAdapter();
    const result = await adapter.scan(platform, { cwd: "/tmp/repo" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings.length).toBe(1);
      expect(result.findings[0].kind).toBe("duplicate");
      expect(result.findings[0].clusterKey).toBe("src/foo.ts:10-src/bar.ts:42");
    }
  });

  test("exit code 0 with no findings → empty result", async () => {
    const platform = makePlatform(async (cmd, args) => {
      if (cmd === "fallow" && args[0] === "--version") return { stdout: "1.2.3", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });
    const adapter = new FallowAdapter();
    const result = await adapter.scan(platform, { cwd: "/tmp/repo" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.findings).toEqual([]);
  });

  test("exit code 2 → execution-failed", async () => {
    const platform = makePlatform(async (cmd, args) => {
      if (cmd === "fallow" && args[0] === "--version") return { stdout: "1.2.3", stderr: "", code: 0 };
      return { stdout: "", stderr: "boom", code: 2 };
    });
    const adapter = new FallowAdapter();
    const result = await adapter.scan(platform, { cwd: "/tmp/repo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("execution-failed");
  });

  test("killed → timeout", async () => {
    const platform = makePlatform(async (cmd, args) => {
      if (cmd === "fallow" && args[0] === "--version") return { stdout: "1.2.3", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 1, killed: true };
    });
    const adapter = new FallowAdapter();
    const result = await adapter.scan(platform, { cwd: "/tmp/repo", timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });
});

describe("FallowAdapter dupes", () => {
  test("passes threshold and min-tokens flags", async () => {
    const calls: string[][] = [];
    const platform = makePlatform(async (cmd, args) => {
      if (cmd === "fallow" && args[0] === "--version") return { stdout: "1.2.3", stderr: "", code: 0 };
      calls.push([cmd, ...args]);
      return { stdout: "", stderr: "", code: 0 };
    });
    const adapter = new FallowAdapter();
    await adapter.dupes(platform, { cwd: "/tmp", threshold: 0.9, minTokenCount: 50 });
    const dupesCall = calls.find((c) => c.includes("dupes"));
    expect(dupesCall).toBeDefined();
    expect(dupesCall).toContain("--threshold");
    expect(dupesCall).toContain("0.9");
    expect(dupesCall).toContain("--min-tokens");
    expect(dupesCall).toContain("50");
  });
});
