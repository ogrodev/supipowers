// tests/commands/context-savings.test.ts
//
// Integration tests for the L1 "Savings" panel rendered by /supi:context
// (plan Tasks 33–35, 52, 53). Mocks the platform paths into a tmpDir so the
// metrics.db lives somewhere the test can inspect, then drives the command
// through `ctx.ui.select` to verify both shape and behavior.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { handleContext } from "../../src/commands/context.js";
import {
  _resetCache,
  registerContextModeHooks,
} from "../../src/context-mode/hooks.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";
import type { PlatformContext, PlatformPaths } from "../../src/platform/types.js";
import { rmDirWithRetry } from "../helpers/fs.js";

let tmpDir: string;
let platform: any;
let ctx: PlatformContext;
let selectMock: ReturnType<typeof mock>;
let notifyMock: ReturnType<typeof mock>;

const SYSTEM_PROMPT = "You are a coding assistant.";

function tmpPaths(): PlatformPaths {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (_cwd: string, ...segments: string[]) =>
      path.join(tmpDir, "project", ...segments),
    global: (...segments: string[]) => path.join(tmpDir, "global", ...segments),
    agent: (...segments: string[]) => path.join(tmpDir, "agent", ...segments),
  };
}

function setup(): void {
  const handlers = new Map<string, Function>();
  platform = createMockPlatform({
    on: mock((event: string, handler: Function) => {
      handlers.set(event, handler);
    }) as any,
    paths: tmpPaths(),
    registerTool: mock(),
  });
  Object.assign(platform, {
    logger: { warn: mock(), error: mock(), debug: mock() },
    _handlers: handlers,
  });

  registerContextModeHooks(platform, DEFAULT_CONFIG);
  const sessionStart = handlers.get("session_start")!;
  sessionStart({}, { cwd: tmpDir });

  selectMock = mock(async () => null);
  notifyMock = mock();
  ctx = {
    cwd: tmpDir,
    hasUI: true,
    ui: {
      select: selectMock as any,
      notify: notifyMock as any,
      input: mock(async () => null),
    },
  };
  // Provide a minimal getSystemPrompt so the existing branch builds at least
  // one breakdown item alongside the savings panel.
  (ctx as any).getSystemPrompt = () => SYSTEM_PROMPT;
}

function shutdown(): void {
  const sd = platform._handlers.get("session_shutdown");
  if (typeof sd === "function") sd({}, {});
  _resetCache();
}

beforeEach(() => {
  _resetCache();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ctx-savings-"));
});

afterEach(() => {
  shutdown();
  rmDirWithRetry(tmpDir);
});

async function runHandleContextOnce(): Promise<string[][]> {
  const calls: string[][] = [];
  selectMock.mockImplementation(async (_title: string, lines: string[]) => {
    calls.push(lines);
    return "Close";
  });
  handleContext(platform, ctx);
  // Wait for the async IIFE inside handleContext to call ctx.ui.select.
  for (let i = 0; i < 40 && calls.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return calls;
}

describe("/supi:context savings panel — Task 33", () => {
  test("prepends the savings lines + a single Metrics DB footer in the right order", async () => {
    setup();
    const calls = await runHandleContextOnce();
    expect(calls.length).toBe(1);
    const lines = calls[0]!;

    // The savings panel and footer appear before any breakdown item that
    // belongs to the system prompt.
    const sessionIdx = lines.findIndex((l) => l.startsWith("Session:"));
    const footerIdx = lines.findIndex((l) => l.startsWith("Metrics DB:"));
    const baseIdx = lines.findIndex((l) =>
      l.startsWith("Memory") || l.startsWith("System") || l.startsWith("Routing") || l.startsWith("Skills") || l.startsWith("Total"),
    );

    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(footerIdx).toBeGreaterThan(sessionIdx);
    if (baseIdx >= 0) {
      expect(footerIdx).toBeLessThan(baseIdx);
    }

    // Footer count must be exactly one.
    expect(lines.filter((l) => l.startsWith("Metrics DB:")).length).toBe(1);

    // The footer renders the absolute path verbatim. The mock's paths.global
    // returns `<tmpDir>/global/...`; the real createPaths interleaves the
    // "supipowers" segment but here we only assert the absolute prefix.
    expect(lines[footerIdx]).toContain(`Metrics DB: ${path.join(tmpDir, "global")}`);
    expect(lines[footerIdx]).toContain(path.join("sessions", "metrics.db"));
  });

  test("Task 52 — footer shows absolute path on every invocation", async () => {
    setup();
    const a = await runHandleContextOnce();
    const b = await runHandleContextOnce();
    const aFooter = a[0]!.find((l) => l.startsWith("Metrics DB:"))!;
    const bFooter = b[0]!.find((l) => l.startsWith("Metrics DB:"))!;
    expect(aFooter).toBe(bFooter);
    expect(aFooter.includes("Metrics DB: /") || aFooter.includes("Metrics DB: C:")).toBe(true);
  });
});

describe("/supi:context drilldown — Task 34", () => {
  test("selecting a savings line writes a markdown drilldown via writeReport", async () => {
    setup();
    let firstCall = true;
    selectMock.mockImplementation(async (_t: string, lines: string[]) => {
      if (firstCall) {
        firstCall = false;
        // Pick the "Saved this session" line (always present).
        return lines.find((l) => l.startsWith("Saved this session:"))!;
      }
      return "Close";
    });

    handleContext(platform, ctx);

    // Wait for both notify (after writeReport) and second select.
    for (let i = 0; i < 60 && (notifyMock as any).mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const reportPath = path.join(tmpDir, ".omp-context-breakdown.md");
    expect(fs.existsSync(reportPath)).toBe(true);
    const content = fs.readFileSync(reportPath, "utf-8");
    expect(content).toContain("# Session savings");
    expect(content).toContain("## Totals");
  });

  test("selecting the footer line is a no-op (does not write a report)", async () => {
    setup();
    let firstCall = true;
    selectMock.mockImplementation(async (_t: string, lines: string[]) => {
      if (firstCall) {
        firstCall = false;
        return lines.find((l) => l.startsWith("Metrics DB:"))!;
      }
      return "Close";
    });

    handleContext(platform, ctx);
    // Give the loop time to iterate.
    await new Promise((r) => setTimeout(r, 50));

    const reportPath = path.join(tmpDir, ".omp-context-breakdown.md");
    expect(fs.existsSync(reportPath)).toBe(false);
  });
});

describe("/supi:context first-run notice — Task 35", () => {
  test("notice appears on first invocation and is suppressed on the second", async () => {
    setup();
    const firstRunCalls = await runHandleContextOnce();
    const firstLines = firstRunCalls[0]!;
    const noticeIdx = firstLines.findIndex((l) => l.startsWith("Measurement enabled."));
    expect(noticeIdx).toBeGreaterThanOrEqual(0);

    // Second invocation: marker has been set, no notice.
    const secondRunCalls = await runHandleContextOnce();
    const secondLines = secondRunCalls[0]!;
    expect(secondLines.some((l) => l.startsWith("Measurement enabled."))).toBe(false);
  });
});

describe("/supi:context degraded mode — Task 31 contract", () => {
  test("when contextMode is disabled, panel falls back gracefully", async () => {
    // Disable context-mode entirely; metrics store is null.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ctx-savings-disabled-"));
    const handlers = new Map<string, Function>();
    platform = createMockPlatform({
      on: mock((event: string, handler: Function) => {
        handlers.set(event, handler);
      }) as any,
      paths: tmpPaths(),
      registerTool: mock(),
    });
    Object.assign(platform, {
      logger: { warn: mock(), error: mock(), debug: mock() },
      _handlers: handlers,
    });
    registerContextModeHooks(platform, {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, enabled: false },
    });

    const localSelect = mock(async () => "Close");
    ctx = {
      cwd: tmpDir,
      hasUI: true,
      ui: {
        select: localSelect as any,
        notify: mock() as any,
        input: mock(async () => null),
      },
    };
    (ctx as any).getSystemPrompt = () => SYSTEM_PROMPT;

    handleContext(platform, ctx);
    for (let i = 0; i < 40 && (localSelect as any).mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const lines: string[] = (localSelect as any).mock.calls[0][1];
    // The fallback line should appear because the store is null.
    expect(lines.some((l) => l.includes("Measurement unavailable"))).toBe(true);
    // Footer is still emitted by the consumer.
    expect(lines.filter((l) => l.startsWith("Metrics DB:")).length).toBe(1);
  });
});
