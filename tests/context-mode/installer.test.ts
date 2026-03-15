// tests/context-mode/installer.test.ts
import { checkInstallation, installContextMode } from "../../src/context-mode/installer.js";

describe("checkInstallation", () => {
  test("detects CLI installed", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "/usr/local/bin/context-mode", code: 0 });
    const status = await checkInstallation(exec, ["ctx_execute"]);
    expect(status.cliInstalled).toBe(true);
    expect(status.toolsAvailable).toBe(true);
  });

  test("detects CLI not installed", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", code: 1 });
    const status = await checkInstallation(exec, []);
    expect(status.cliInstalled).toBe(false);
    expect(status.toolsAvailable).toBe(false);
  });

  test("reports version when available", async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: "/usr/local/bin/context-mode", code: 0 })
      .mockResolvedValueOnce({ stdout: "1.2.3\n", code: 0 });
    const status = await checkInstallation(exec, []);
    expect(status.version).toBe("1.2.3");
  });

  test("handles version check failure", async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: "/usr/local/bin/context-mode", code: 0 })
      .mockResolvedValueOnce({ stdout: "", code: 1 });
    const status = await checkInstallation(exec, []);
    expect(status.cliInstalled).toBe(true);
    expect(status.version).toBeNull();
  });
});

describe("installContextMode", () => {
  test("calls npm install -g", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "added 1 package", code: 0 });
    const result = await installContextMode(exec);
    expect(result.success).toBe(true);
    expect(exec).toHaveBeenCalledWith("npm", ["install", "-g", "context-mode"]);
  });

  test("reports failure", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", code: 1 });
    const result = await installContextMode(exec);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
