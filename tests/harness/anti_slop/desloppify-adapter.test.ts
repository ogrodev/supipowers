import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  DesloppifyAdapter,
  _resetDesloppifyAvailabilityCacheForTests,
} from "../../../src/harness/anti_slop/desloppify-adapter.js";

beforeEach(() => {
  _resetDesloppifyAvailabilityCacheForTests();
});

afterEach(() => {
  _resetDesloppifyAvailabilityCacheForTests();
});

function makePlatform(handler: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>) {
  return {
    exec: mock(handler),
    paths: {} as any,
  } as any;
}

describe("DesloppifyAdapter availability", () => {
  test("native CLI present → ok", async () => {
    const platform = makePlatform(async (cmd) => {
      if (cmd === "desloppify") return { stdout: "desloppify 0.5.0", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 127 };
    });
    expect(await new DesloppifyAdapter().isAvailable(platform)).toBe(true);
  });

  test("falls back to python -m desloppify when binary missing but Python ≥3.11 + module available", async () => {
    const platform = makePlatform(async (cmd, args) => {
      if (cmd === "desloppify") return { stdout: "", stderr: "missing", code: 127 };
      if (cmd === "python3" && args[0] === "--version") return { stdout: "Python 3.12.1", stderr: "", code: 0 };
      if (cmd === "python3" && args.includes("desloppify")) return { stdout: "0.5.0", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 127 };
    });
    expect(await new DesloppifyAdapter().isAvailable(platform)).toBe(true);
  });

  test("Python < 3.11 → not-installed", async () => {
    const platform = makePlatform(async (cmd) => {
      if (cmd === "desloppify") return { stdout: "", stderr: "missing", code: 127 };
      if (cmd === "python3") return { stdout: "Python 3.9.5", stderr: "", code: 0 };
      if (cmd === "python") return { stdout: "Python 2.7.18", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 127 };
    });
    expect(await new DesloppifyAdapter().isAvailable(platform)).toBe(false);
  });
});

describe("DesloppifyAdapter scan", () => {
  test("parses JSON findings", async () => {
    const platform = makePlatform(async (cmd, args) => {
      if (cmd === "desloppify" && args[0] === "--version") return { stdout: "0.5.0", stderr: "", code: 0 };
      if (args.includes("scan")) {
        return {
          stdout: JSON.stringify({
            findings: [
              {
                id: "dpf-1",
                kind: "dead-code",
                file: "src/foo.py",
                start_line: 5,
                end_line: 7,
                severity: "warning",
                message: "unused function",
              },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const result = await new DesloppifyAdapter().scan(platform, { cwd: "/tmp" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings.length).toBe(1);
      expect(result.findings[0].kind).toBe("dead-code");
      expect(result.findings[0].source).toBe("desloppify");
    }
  });
});
