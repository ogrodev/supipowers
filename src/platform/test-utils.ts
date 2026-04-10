import { tmpdir } from "node:os";
import { join } from "node:path";

// src/platform/test-utils.ts
import { mock } from "bun:test";
import type { Platform, PlatformContext } from "./types.js";
import { createPaths } from "./types.js";

export function createMockPlatform(overrides?: Partial<Platform>): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    getActiveTools: mock(() => []),
    exec: mock(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: mock(),
    sendUserMessage: mock(),
    registerMessageRenderer: mock(),
    on: mock(),
    createAgentSession: mock(async () => ({
      subscribe: mock(() => () => {}),
      prompt: mock(async () => {}),
      state: { messages: [] },
      dispose: mock(async () => {}),
    })),
    paths: createPaths(".omp"),
    capabilities: {
      agentSessions: true,
      compactionHooks: true,
      customWidgets: true,
      registerTool: true,
    },
    ...overrides,
  };
}

export function createMockContext(overrides?: Partial<PlatformContext>): PlatformContext {
  return {
    cwd: join(tmpdir(), "test"),
    hasUI: true,
    ui: {
      select: mock(async () => null),
      notify: mock(),
      input: mock(async () => null),
    },
    ...overrides,
  };
}
