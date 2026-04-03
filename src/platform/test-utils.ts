// src/platform/test-utils.ts
import { vi } from "vitest";
import type { Platform, PlatformContext } from "./types.js";
import { createPaths } from "./types.js";

export function createMockPlatform(overrides?: Partial<Platform>): Platform {
  return {
    name: "omp",
    registerCommand: vi.fn(),
    getCommands: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
    createAgentSession: vi.fn(async () => ({
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => {}),
      state: { messages: [] },
      dispose: vi.fn(async () => {}),
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
    cwd: "/tmp/test",
    hasUI: true,
    ui: {
      select: vi.fn(async () => null),
      notify: vi.fn(),
      input: vi.fn(async () => null),
    },
    ...overrides,
  };
}
