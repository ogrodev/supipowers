// tests/context-mode/installer.test.ts
//
// context-mode is detected via filesystem (not exec) — the checkFn in registry.ts
// checks for start.mjs under ~/.omp/extensions/context-mode/ and ignores exec.
// installCmd is null, so installContextMode always reports failure.

import { checkInstallation, installContextMode } from "../../src/context-mode/installer.js";
import { DEPENDENCIES } from "../../src/deps/registry.js";

const contextModeDep = DEPENDENCIES.find((d) => d.binary === "context-mode")!;

describe("checkInstallation", () => {
  let originalCheckFn: typeof contextModeDep.checkFn;

  beforeEach(() => {
    originalCheckFn = contextModeDep.checkFn;
    // Default: simulate not installed
    contextModeDep.checkFn = async () => ({ installed: false });
  });

  afterEach(() => {
    contextModeDep.checkFn = originalCheckFn;
  });

  test("detects CLI installed (via filesystem)", async () => {
    contextModeDep.checkFn = async () => ({ installed: true, version: "extension" });
    const exec = vi.fn();
    const status = await checkInstallation(exec, ["ctx_execute"]);
    expect(status.cliInstalled).toBe(true);
    expect(status.toolsAvailable).toBe(true);
    expect(status.version).toBe("extension");
  });

  test("detects CLI not installed", async () => {
    const exec = vi.fn();
    const status = await checkInstallation(exec, []);
    expect(status.cliInstalled).toBe(false);
    expect(status.toolsAvailable).toBe(false);
  });

  test("reports extension as version when installed", async () => {
    contextModeDep.checkFn = async () => ({ installed: true, version: "extension" });
    const exec = vi.fn();
    const status = await checkInstallation(exec, []);
    expect(status.version).toBe("extension");
  });

  test("reports null version when not installed", async () => {
    const exec = vi.fn();
    const status = await checkInstallation(exec, []);
    expect(status.version).toBeNull();
  });
});

describe("installContextMode", () => {
  test("reports failure (no install command configured)", async () => {
    const exec = vi.fn();
    const result = await installContextMode(exec);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
