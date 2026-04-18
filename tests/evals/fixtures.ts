// tests/evals/fixtures.ts
//
// Shared fixtures for behavior evals: a capture-heavy mock platform,
// a mock command context, and a temp workspace with `.omp/supipowers/`
// directories pre-created. Evals should import from here rather than
// reinventing mock shapes — consistency matters so regressions fail the
// same way across every eval.

import { mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Platform mock
// ---------------------------------------------------------------------------

export interface MockPlatformOptions {
  /** Workspace root used by platform.paths.project. */
  cwd?: string;
  /** Tools reported by platform.getActiveTools(). */
  activeTools?: string[];
}

export interface CommandDefinition {
  description: string;
  handler: (args: string | undefined, ctx: any) => any;
}

export interface RegisteredTool {
  name: string;
  description?: string;
  parameters?: any;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (...args: any[]) => any;
}

export interface CapturedPlatform {
  /** The mock platform object to pass to register functions. */
  platform: any;
  /** event name → handlers registered via platform.on(). */
  capturedHooks: Record<string, Array<(...args: any[]) => any>>;
  /** command name → definition registered via platform.registerCommand(). */
  capturedCommands: Record<string, CommandDefinition>;
  /** tool name → definition registered via platform.registerTool(). */
  capturedTools: Record<string, RegisteredTool>;
  /** All sendMessage invocations, in order. */
  sentMessages: Array<{ message: any; options?: any }>;
  /** All sendUserMessage invocations, in order. */
  sentUserMessages: string[];
  /** All platform.exec invocations, in order. */
  execCalls: Array<{ cmd: string; args: string[]; opts?: any }>;
  /**
   * Fire a registered hook with the given payload. Returns the array of
   * handler return values (in registration order).
   */
  fireHook: (event: string, ...payload: any[]) => Promise<any[]>;
}

/**
 * Build a mock platform with complete capture of commands, tools, hooks,
 * and messages. Defaults are sane for most evals; override via `opts`.
 */
export function makeEvalPlatform(opts: MockPlatformOptions = {}): CapturedPlatform {
  const cwd = opts.cwd ?? process.cwd();
  const capturedHooks: Record<string, Array<(...args: any[]) => any>> = {};
  const capturedCommands: Record<string, CommandDefinition> = {};
  const capturedTools: Record<string, RegisteredTool> = {};
  const sentMessages: Array<{ message: any; options?: any }> = [];
  const sentUserMessages: string[] = [];
  const execCalls: Array<{ cmd: string; args: string[]; opts?: any }> = [];

  const platform: any = {
    paths: {
      dotDirDisplay: ".omp",
      agent: (...parts: string[]) => path.join(cwd, ".omp", ...parts),
      project: (projectCwd: string, ...parts: string[]) =>
        path.join(projectCwd, ".omp", "supipowers", ...parts),
    },
    registerCommand: mock((name: string, def: CommandDefinition) => {
      capturedCommands[name] = def;
    }),
    registerTool: mock((def: RegisteredTool) => {
      capturedTools[def.name] = def;
    }),
    registerMessageRenderer: mock(),
    on: mock((event: string, handler: (...args: any[]) => any) => {
      (capturedHooks[event] ??= []).push(handler);
    }),
    sendMessage: mock((message: any, options?: any) => {
      sentMessages.push({ message, options });
    }),
    sendUserMessage: mock((text: string) => {
      sentUserMessages.push(text);
    }),
    getActiveTools: mock(() => opts.activeTools ?? []),
    setActiveTools: mock(),
    getCommands: mock(() => Object.keys(capturedCommands)),
    exec: mock(async (cmd: string, args: string[], execOpts?: any) => {
      execCalls.push({ cmd, args, opts: execOpts });
      return { code: 0, stdout: "", stderr: "" };
    }),
    createAgentSession: mock(),
    logger: { error: mock(), warn: mock(), info: mock() },
  };

  const fireHook = async (event: string, ...payload: any[]): Promise<any[]> => {
    const handlers = capturedHooks[event] ?? [];
    const results: any[] = [];
    for (const h of handlers) {
      results.push(await h(...payload));
    }
    return results;
  };

  return {
    platform,
    capturedHooks,
    capturedCommands,
    capturedTools,
    sentMessages,
    sentUserMessages,
    execCalls,
    fireHook,
  };
}

// ---------------------------------------------------------------------------
// Context mock
// ---------------------------------------------------------------------------

export interface MockCtxOverrides {
  hasUI?: boolean;
  cwd?: string;
  ui?: Partial<MockCtx["ui"]>;
  newSession?: ReturnType<typeof mock>;
  sendUserMessage?: ReturnType<typeof mock>;
}

export interface MockCtx {
  hasUI: boolean;
  cwd: string;
  ui: {
    select: ReturnType<typeof mock>;
    input: ReturnType<typeof mock>;
    setEditorText: ReturnType<typeof mock>;
    notify: ReturnType<typeof mock>;
    setStatus: ReturnType<typeof mock>;
    custom: ReturnType<typeof mock>;
  };
  newSession: ReturnType<typeof mock>;
  sendUserMessage: ReturnType<typeof mock>;
}

/**
 * Build a mock command context. `ui.select` returns undefined by default so
 * evals that care about a specific user choice must override it explicitly.
 */
export function makeEvalContext(overrides: MockCtxOverrides = {}): MockCtx {
  const base: MockCtx = {
    hasUI: overrides.hasUI ?? true,
    cwd: overrides.cwd ?? process.cwd(),
    ui: {
      select: mock(),
      input: mock(),
      setEditorText: mock(),
      notify: mock(),
      setStatus: mock(),
      custom: mock(),
    },
    newSession: overrides.newSession ?? mock().mockResolvedValue({ cancelled: false }),
    sendUserMessage: overrides.sendUserMessage ?? mock(),
  };
  if (overrides.ui) Object.assign(base.ui, overrides.ui);
  return base;
}

// ---------------------------------------------------------------------------
// Temp workspace
// ---------------------------------------------------------------------------

export interface TempWorkspace {
  /** Absolute path to the temp workspace root. Use as `ctx.cwd`. */
  dir: string;
  /** Remove the temp workspace. Call in afterEach / finally. */
  cleanup: () => void;
  /** Write a plan markdown file under .omp/supipowers/plans/. */
  writePlan: (name: string, content: string) => string;
  /** Current plan filenames (sorted). */
  listPlans: () => string[];
}

/**
 * Create a temp directory with `.omp/supipowers/plans/` pre-created so
 * plan-write and plan-list helpers work out of the box.
 */
export function makeTempWorkspace(): TempWorkspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-eval-"));
  const plansDir = path.join(dir, ".omp", "supipowers", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    },
    writePlan: (name: string, content: string) => {
      const p = path.join(plansDir, name);
      fs.writeFileSync(p, content);
      return p;
    },
    listPlans: () =>
      fs.existsSync(plansDir)
        ? fs.readdirSync(plansDir).filter((f) => f.endsWith(".md")).sort()
        : [],
  };
}
