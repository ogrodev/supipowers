import { describe, expect, mock, test } from "bun:test";
import type { Platform } from "../../src/platform/types.js";
import { showSupiDialog } from "../../src/commands/supi.js";

function createPlatform(): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (_cwd: string, ...segments: string[]) => segments.join("/"),
      global: (...segments: string[]) => segments.join("/"),
      agent: (...segments: string[]) => segments.join("/"),
    },
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
  } as unknown as Platform;
}


describe("showSupiDialog", () => {
  test("shows command list with workspace-aware overview status", async () => {
    const platform = createPlatform();
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      ui: { select: mock(async () => null), notify: mock() },
    } as any;

    await showSupiDialog(platform, ctx);

    expect(ctx.ui.select).toHaveBeenCalledWith(
      "Supipowers",
      expect.arrayContaining([
        expect.stringContaining("/supi:plan"),
        expect.stringContaining("Last checks: none"),
      ]),
      expect.objectContaining({ helpText: "Select a command to run · Esc to close" }),
    );
  });
});
