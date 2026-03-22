# Dual-Platform Abstraction Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make supipowers installable and functional on both Pi and OMP from a single npm package (v1.0.0).

**Architecture:** Runtime platform detection at startup selects a Pi or OMP adapter. Both implement a shared `Platform` interface. All extension code talks to `Platform`, never to platform-specific APIs. A `PlatformPaths` utility centralizes all directory resolution.

**Tech Stack:** TypeScript, Vitest, `@mariozechner/pi-coding-agent` (Pi), `@oh-my-pi/pi-coding-agent` (OMP), `@sinclair/typebox`

**Spec:** `docs/2026-03-22-dual-platform-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/platform/types.ts` | `Platform`, `PlatformPaths`, `PlatformCapabilities`, `AgentSession`, `PlatformContext`, `PlatformUI` interfaces |
| `src/platform/detect.ts` | `detectPlatform(rawApi)` — inspect API object shape to determine platform |
| `src/platform/pi.ts` | `createPiAdapter(rawApi)` — near pass-through adapter for Pi |
| `src/platform/omp.ts` | `createOmpAdapter(rawApi)` — translating adapter for OMP |
| `src/platform/test-utils.ts` | `createMockPlatform()`, `createMockContext()` — test factories |
| `src/bootstrap.ts` | `bootstrap(platform)` — extracted from `index.ts`, registers everything |
| `tests/platform/detect.test.ts` | Detection tests |
| `tests/platform/pi-adapter.test.ts` | Pi adapter pass-through tests |
| `tests/platform/omp-adapter.test.ts` | OMP adapter translation tests |
| `tests/integration/dual-platform.test.ts` | Smoke test: both platforms bootstrap |

### Modified files (by task)

| Task | Files modified |
|------|---------------|
| 7 | `src/index.ts` (rewrite) |
| 8 | `src/config/loader.ts`, `src/config/profiles.ts` |
| 9 | `src/storage/plans.ts`, `src/storage/reports.ts`, `src/storage/runs.ts`, `src/storage/fix-pr-sessions.ts`, `src/storage/qa-sessions.ts` |
| 10 | `src/qa/config.ts`, `src/qa/matrix.ts`, `src/qa/session.ts`, `src/fix-pr/config.ts` |
| 11 | `src/visual/companion.ts`, `src/context-mode/hooks.ts` |
| 12 | All 10 `src/commands/*.ts`, `src/lsp/bridge.ts` |
| 13 | `src/orchestrator/dispatcher.ts`, `src/orchestrator/progress-renderer.ts` |
| 14 | `src/qa/prompt-builder.ts`, `src/planning/plan-writer-prompt.ts` |
| 15 | `src/commands/update.ts` (already counted in task 12, but has extra platform-specific update logic) |
| 16 | `package.json` |
| 17 | `bin/install.mjs` |

---

### Task 1: Platform Types

**Files:**
- Create: `src/platform/types.ts`

- [ ] **Step 1: Create the Platform interface file**

```typescript
// src/platform/types.ts
import { join } from "node:path";
import { homedir } from "node:os";

// ── Path Resolution ────────────────────────────────────────

export interface PlatformPaths {
  /** The dot-directory name: ".pi" or ".omp" */
  dotDir: string;
  /** For user-visible messages and LLM prompts */
  dotDirDisplay: string;
  /** Resolve project-local: paths.project(cwd, "plans") → "<cwd>/.pi/supipowers/plans" */
  project(cwd: string, ...segments: string[]): string;
  /** Resolve global: paths.global("config.json") → "~/.pi/supipowers/config.json" */
  global(...segments: string[]): string;
  /** Resolve agent-level: paths.agent("extensions") → "~/.pi/agent/extensions" */
  agent(...segments: string[]): string;
}

export function createPaths(dotDir: string): PlatformPaths {
  return {
    dotDir,
    dotDirDisplay: dotDir,
    project: (cwd: string, ...segments: string[]) =>
      join(cwd, dotDir, "supipowers", ...segments),
    global: (...segments: string[]) =>
      join(homedir(), dotDir, "supipowers", ...segments),
    agent: (...segments: string[]) =>
      join(homedir(), dotDir, "agent", ...segments),
  };
}

// ── Capabilities ───────────────────────────────────────────

export interface PlatformCapabilities {
  agentSessions: boolean;
  compactionHooks: boolean;
  customWidgets: boolean;
  registerTool: boolean;
}

// ── Agent Sessions ─────────────────────────────────────────

export interface AgentSessionOptions {
  cwd?: string;
  taskDepth?: number;
  parentTaskPrefix?: string;
  [key: string]: unknown;
}

export interface AgentSession {
  subscribe(handler: (event: any) => void): () => void;
  prompt(text: string, opts?: { expandPromptTemplates?: boolean }): Promise<void>;
  state: { messages: any[] };
  dispose(): Promise<void>;
}

// ── Exec ───────────────────────────────────────────────────

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

// ── Messages ───────────────────────────────────────────────

export interface SendMessageOptions {
  deliverAs?: "steer" | "followUp" | "nextTurn";
  triggerTurn?: boolean;
}

// ── Commands ───────────────────────────────────────────────

export interface CommandInfo {
  name: string;
  description?: string;
  source?: string;
}

// ── Context ────────────────────────────────────────────────

export interface PlatformContext {
  cwd: string;
  hasUI: boolean;
  ui: PlatformUI;
}

export interface PlatformUI {
  select(title: string, options: any[], opts?: any): Promise<string | null>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  input(label: string, opts?: any): Promise<string | null>;
  confirm?(title: string, message: string): Promise<boolean>;
  setWidget?(name: string, content: any): void;
  setStatus?(key: string, text: string | undefined): void;
}

// ── Platform ───────────────────────────────────────────────

export interface Platform {
  name: "pi" | "omp";

  // Commands
  registerCommand(name: string, opts: any): void;
  getCommands(): CommandInfo[];

  // Events
  on(event: string, handler: (...args: any[]) => any): void;

  // Execution
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  sendMessage(content: any, opts?: SendMessageOptions): void;

  // Introspection
  getActiveTools(): string[];

  // Rendering
  registerMessageRenderer<T>(type: string, renderer: any): void;

  // Agent Sessions
  createAgentSession(opts: AgentSessionOptions): Promise<AgentSession>;

  // Paths
  paths: PlatformPaths;

  // Capabilities
  capabilities: PlatformCapabilities;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/platform/types.ts`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/platform/types.ts
git commit -m "feat(platform): add Platform interface and PlatformPaths types"
```

---

### Task 2: Platform Detection

**Files:**
- Create: `src/platform/detect.ts`
- Create: `tests/platform/detect.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/platform/detect.test.ts
import { describe, it, expect } from "vitest";
import { detectPlatform } from "../../src/platform/detect.js";

describe("detectPlatform", () => {
  it("returns 'omp' when rawApi has pi.createAgentSession", () => {
    const rawApi = {
      pi: { createAgentSession: () => {} },
      registerCommand: () => {},
    };
    expect(detectPlatform(rawApi)).toBe("omp");
  });

  it("returns 'pi' when rawApi lacks pi.createAgentSession", () => {
    const rawApi = {
      registerCommand: () => {},
      getActiveTools: () => [],
    };
    expect(detectPlatform(rawApi)).toBe("pi");
  });

  it("returns 'pi' when rawApi.pi exists but has no createAgentSession", () => {
    const rawApi = {
      pi: { somethingElse: true },
      registerCommand: () => {},
    };
    expect(detectPlatform(rawApi)).toBe("pi");
  });

  it("returns 'pi' for empty object", () => {
    expect(detectPlatform({})).toBe("pi");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/platform/detect.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement detection**

```typescript
// src/platform/detect.ts
export type PlatformType = "pi" | "omp";

export function detectPlatform(rawApi: any): PlatformType {
  if (rawApi.pi && typeof rawApi.pi.createAgentSession === "function") {
    return "omp";
  }
  return "pi";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/platform/detect.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/platform/detect.ts tests/platform/detect.test.ts
git commit -m "feat(platform): add runtime platform detection"
```

---

### Task 3: Pi Adapter

**Files:**
- Create: `src/platform/pi.ts`
- Create: `tests/platform/pi-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/platform/pi-adapter.test.ts
import { describe, it, expect, vi } from "vitest";
import { createPiAdapter } from "../../src/platform/pi.js";

function createMockPiApi() {
  return {
    registerCommand: vi.fn(),
    getCommands: vi.fn(() => []),
    getActiveTools: vi.fn(() => ["Bash", "Read"]),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
  };
}

describe("createPiAdapter", () => {
  it("returns platform with name 'pi'", () => {
    const adapter = createPiAdapter(createMockPiApi());
    expect(adapter.name).toBe("pi");
  });

  it("passes registerCommand through", () => {
    const raw = createMockPiApi();
    const adapter = createPiAdapter(raw);
    adapter.registerCommand("test", { description: "test" });
    expect(raw.registerCommand).toHaveBeenCalledWith("test", { description: "test" });
  });

  it("passes exec through", async () => {
    const raw = createMockPiApi();
    raw.exec.mockResolvedValue({ stdout: "ok", stderr: "", code: 0 });
    const adapter = createPiAdapter(raw);
    const result = await adapter.exec("git", ["status"], { cwd: "/tmp" });
    expect(raw.exec).toHaveBeenCalledWith("git", ["status"], { cwd: "/tmp" });
    expect(result.stdout).toBe("ok");
  });

  it("passes on() through", () => {
    const raw = createMockPiApi();
    const handler = vi.fn();
    const adapter = createPiAdapter(raw);
    adapter.on("tool_call", handler);
    expect(raw.on).toHaveBeenCalledWith("tool_call", handler);
  });

  it("has Pi paths using .pi directory", () => {
    const adapter = createPiAdapter(createMockPiApi());
    expect(adapter.paths.dotDir).toBe(".pi");
    expect(adapter.paths.project("/proj", "plans")).toContain(".pi/supipowers/plans");
  });

  it("reports all capabilities as true", () => {
    const adapter = createPiAdapter(createMockPiApi());
    expect(adapter.capabilities.agentSessions).toBe(true);
    expect(adapter.capabilities.compactionHooks).toBe(true);
    expect(adapter.capabilities.registerTool).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/platform/pi-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement Pi adapter**

```typescript
// src/platform/pi.ts
import type { Platform, AgentSession, AgentSessionOptions } from "./types.js";
import { createPaths } from "./types.js";

export function createPiAdapter(pi: any): Platform {
  return {
    name: "pi",
    registerCommand: (name, opts) => pi.registerCommand(name, opts),
    getCommands: () => pi.getCommands(),
    getActiveTools: () => pi.getActiveTools(),
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    sendMessage: (content, opts) => {
      pi.sendMessage(content, {
        deliverAs: opts?.deliverAs ?? "steer",
        triggerTurn: opts?.triggerTurn ?? true,
        ...opts,
      });
    },
    registerMessageRenderer: (type, fn) => pi.registerMessageRenderer(type, fn),
    on: (event, handler) => pi.on(event, handler),

    createAgentSession: async (opts: AgentSessionOptions): Promise<AgentSession> => {
      const mod = await import("@mariozechner/pi-coding-agent");
      const createFn = (mod as any).createAgentSession;
      const { session } = await createFn({
        cwd: opts.cwd ?? process.cwd(),
        hasUI: false,
        ...opts,
      });
      return {
        subscribe: (handler: any) => session.subscribe(handler),
        prompt: (text: string, promptOpts?: any) => session.prompt(text, promptOpts),
        state: session.state,
        dispose: () => session.dispose(),
      };
    },

    paths: createPaths(".pi"),

    capabilities: {
      agentSessions: true,
      compactionHooks: true,
      customWidgets: true,
      registerTool: true,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/platform/pi-adapter.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/platform/pi.ts tests/platform/pi-adapter.test.ts
git commit -m "feat(platform): add Pi adapter"
```

---

### Task 4: OMP Adapter

**Files:**
- Create: `src/platform/omp.ts`
- Create: `tests/platform/omp-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/platform/omp-adapter.test.ts
import { describe, it, expect, vi } from "vitest";
import { createOmpAdapter } from "../../src/platform/omp.js";

function createMockOmpApi() {
  return {
    pi: { createAgentSession: vi.fn(async () => ({
      session: {
        subscribe: vi.fn(() => () => {}),
        prompt: vi.fn(async () => {}),
        state: { messages: [] },
        dispose: vi.fn(async () => {}),
      },
    })) },
    registerCommand: vi.fn(),
    getCommands: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
  };
}

describe("createOmpAdapter", () => {
  it("returns platform with name 'omp'", () => {
    const adapter = createOmpAdapter(createMockOmpApi());
    expect(adapter.name).toBe("omp");
  });

  it("has OMP paths using .omp directory", () => {
    const adapter = createOmpAdapter(createMockOmpApi());
    expect(adapter.paths.dotDir).toBe(".omp");
    expect(adapter.paths.project("/proj", "plans")).toContain(".omp/supipowers/plans");
  });

  it("normalizes input event: { action: 'handled' } → { handled: true }", () => {
    const raw = createMockOmpApi();
    const adapter = createOmpAdapter(raw);

    adapter.on("input", () => ({ action: "handled" }));

    // Verify the handler registered on OMP is a wrapper
    expect(raw.on).toHaveBeenCalledWith("input", expect.any(Function));

    // Call the OMP-side wrapper and check it translates
    const ompHandler = raw.on.mock.calls[0][1];
    const result = ompHandler({ text: "/supi" }, {});
    expect(result).toEqual({ handled: true });
  });

  it("maps session_compact to session.compacting on OMP", () => {
    const raw = createMockOmpApi();
    const adapter = createOmpAdapter(raw);
    const handler = vi.fn();

    adapter.on("session_compact", handler);

    expect(raw.on).toHaveBeenCalledWith("session.compacting", handler);
  });

  it("passes non-translated events through", () => {
    const raw = createMockOmpApi();
    const adapter = createOmpAdapter(raw);
    const handler = vi.fn();

    adapter.on("tool_call", handler);
    expect(raw.on).toHaveBeenCalledWith("tool_call", handler);
  });

  it("creates agent sessions via pi.pi.createAgentSession", async () => {
    const raw = createMockOmpApi();
    const adapter = createOmpAdapter(raw);

    const session = await adapter.createAgentSession({ cwd: "/tmp" });
    expect(raw.pi.createAgentSession).toHaveBeenCalled();
    expect(session.subscribe).toBeDefined();
    expect(session.prompt).toBeDefined();
    expect(session.dispose).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/platform/omp-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement OMP adapter**

```typescript
// src/platform/omp.ts
import type { Platform, AgentSession, AgentSessionOptions } from "./types.js";
import { createPaths } from "./types.js";

export function createOmpAdapter(pi: any): Platform {
  return {
    name: "omp",
    registerCommand: (name, opts) => pi.registerCommand(name, opts),
    getCommands: () => pi.getCommands(),
    getActiveTools: () => pi.getActiveTools(),
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    sendMessage: (content, opts) => pi.sendMessage(content, opts),
    registerMessageRenderer: (type, fn) => pi.registerMessageRenderer(type, fn),

    on: (event: string, handler: any) => {
      // Normalize input event return shape
      if (event === "input") {
        pi.on("input", (evt: any, ctx: any) => {
          const result = handler(evt, ctx);
          if (result?.action === "handled") return { handled: true };
          if (result?.action === "transform") return { handled: true, text: result.text };
          return result;
        });
        return;
      }

      // Map Pi's session_compact to OMP's session.compacting
      if (event === "session_compact") {
        pi.on("session.compacting", handler);
        return;
      }

      // All other events pass through
      pi.on(event, handler);
    },

    createAgentSession: async (opts: AgentSessionOptions): Promise<AgentSession> => {
      const { createAgentSession } = pi.pi;
      const { session } = await createAgentSession({
        cwd: opts.cwd ?? process.cwd(),
        hasUI: false,
        disableExtensionDiscovery: true,
        skills: [],
        promptTemplates: [],
        slashCommands: [],
        ...opts,
      });
      return {
        subscribe: (handler: any) => session.subscribe(handler),
        prompt: (text: string, promptOpts?: any) => session.prompt(text, promptOpts),
        state: session.state,
        dispose: () => session.dispose(),
      };
    },

    paths: createPaths(".omp"),

    capabilities: {
      agentSessions: true,
      compactionHooks: true,
      customWidgets: true,
      registerTool: false,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/platform/omp-adapter.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/platform/omp.ts tests/platform/omp-adapter.test.ts
git commit -m "feat(platform): add OMP adapter with event translation"
```

---

### Task 5: Test Utilities

**Files:**
- Create: `src/platform/test-utils.ts`

- [ ] **Step 1: Create mock factory**

```typescript
// src/platform/test-utils.ts
import { vi } from "vitest";
import type { Platform, PlatformContext } from "./types.js";
import { createPaths } from "./types.js";

export function createMockPlatform(overrides?: Partial<Platform>): Platform {
  return {
    name: "pi",
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
    paths: createPaths(".pi"),
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
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/platform/test-utils.ts`
Expected: No errors (may need vitest types in scope — verify).

- [ ] **Step 3: Commit**

```bash
git add src/platform/test-utils.ts
git commit -m "feat(platform): add test mock factories"
```

---

### Task 6: Bootstrap Extraction

Extract the registration logic from `src/index.ts` into `src/bootstrap.ts` that takes `Platform` instead of `ExtensionAPI`. This is the core switchover.

**Files:**
- Create: `src/bootstrap.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create bootstrap.ts**

Create `src/bootstrap.ts` that mirrors the current `index.ts` registration logic but accepts `Platform`:

```typescript
// src/bootstrap.ts
import type { Platform } from "./platform/types.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSupiCommand, handleSupi } from "./commands/supi.js";
import { registerConfigCommand, handleConfig } from "./commands/config.js";
import { registerStatusCommand, handleStatus } from "./commands/status.js";
import { registerPlanCommand, getActiveVisualSessionDir, setActiveVisualSessionDir } from "./commands/plan.js";
import { getScriptsDir } from "./visual/companion.js";
import { registerRunCommand } from "./commands/run.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerQaCommand } from "./commands/qa.js";
import { registerReleaseCommand } from "./commands/release.js";
import { registerUpdateCommand, handleUpdate } from "./commands/update.js";
import { registerFixPrCommand } from "./commands/fix-pr.js";
import { loadConfig } from "./config/loader.js";
import { registerContextModeHooks } from "./context-mode/hooks.js";
import { registerProgressRenderer } from "./orchestrator/progress-renderer.js";

const TUI_COMMANDS: Record<string, (platform: Platform, ctx: any) => void> = {
  "supi": (platform, ctx) => handleSupi(platform, ctx),
  "supi:config": (platform, ctx) => handleConfig(platform, ctx),
  "supi:status": (_platform, ctx) => handleStatus(ctx),
  "supi:update": (platform, ctx) => handleUpdate(platform, ctx),
};

function getInstalledVersion(platform: Platform): string | null {
  const pkgPath = platform.paths.agent("extensions", "supipowers", "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    return null;
  }
}

export function bootstrap(platform: Platform): void {
  // Register all commands
  registerSupiCommand(platform);
  registerConfigCommand(platform);
  registerStatusCommand(platform);
  registerPlanCommand(platform);
  registerRunCommand(platform);
  registerReviewCommand(platform);
  registerQaCommand(platform);
  registerReleaseCommand(platform);
  registerUpdateCommand(platform);
  registerFixPrCommand(platform);

  // Register custom message renderers
  registerProgressRenderer(platform);

  // Intercept TUI-only commands
  platform.on("input", (event: any, ctx: any) => {
    const text = event.text.trim();
    if (!text.startsWith("/")) return;

    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);

    const handler = TUI_COMMANDS[commandName];
    if (!handler) return;

    handler(platform, ctx);
    // Return Pi convention — the OMP adapter translates this to { handled: true }
    return { action: "handled" };
  });

  // Context-mode integration
  const config = loadConfig(process.cwd(), platform.paths);
  registerContextModeHooks(platform, config);

  // Session start
  platform.on("session_start", async (_event: any, ctx: any) => {
    const previousVisualDir = getActiveVisualSessionDir();
    if (previousVisualDir) {
      const stopScript = join(getScriptsDir(), "stop-server.sh");
      platform.exec("bash", [stopScript, previousVisualDir], { cwd: getScriptsDir() }).catch(() => {});
      setActiveVisualSessionDir(null);
    }

    const currentVersion = getInstalledVersion(platform);
    if (!currentVersion) return;

    platform.exec("npm", ["view", "supipowers", "version"], { cwd: tmpdir() })
      .then((result) => {
        if (result.code !== 0) return;
        const latest = result.stdout.trim();
        if (latest && latest !== currentVersion) {
          ctx.ui.notify(
            `supipowers v${latest} available (current: v${currentVersion}). Run /supi:update`,
            "info",
          );
        }
      })
      .catch(() => {});
  });
}
```

**Note:** This will not compile yet because the command `register*` functions still expect `ExtensionAPI`. That's OK — we're creating the target shape. Commands will be migrated in Task 12.

- [ ] **Step 2: Rewrite index.ts**

Replace `src/index.ts` with the detection + adapter + bootstrap entry point:

```typescript
// src/index.ts
import { detectPlatform } from "./platform/detect.js";
import { createOmpAdapter } from "./platform/omp.js";
import { createPiAdapter } from "./platform/pi.js";
import { bootstrap } from "./bootstrap.js";

export default function supipowers(rawApi: any): void {
  const platformType = detectPlatform(rawApi);
  const platform = platformType === "omp"
    ? createOmpAdapter(rawApi)
    : createPiAdapter(rawApi);

  bootstrap(platform);
}
```

- [ ] **Step 3: Commit (WIP — won't compile until commands are migrated)**

```bash
git add src/bootstrap.ts src/index.ts
git commit -m "wip: extract bootstrap and rewrite entry point for Platform"
```

---

### Task 7: Typecheck Checkpoint

Before migrating consumers, verify the platform layer itself is sound.

- [ ] **Step 1: Run platform-layer tests only**

Run: `npx vitest run tests/platform/`
Expected: All detect + adapter tests pass.

- [ ] **Step 2: Run typecheck on platform files only**

Run: `npx tsc --noEmit src/platform/types.ts src/platform/detect.ts src/platform/pi.ts src/platform/omp.ts`
Expected: No errors.

---

### Task 8: Config Path Migration

Migrate `config/loader.ts` and `config/profiles.ts` to use `PlatformPaths`.

**Files:**
- Modify: `src/config/loader.ts`
- Modify: `src/config/profiles.ts`
- Modify: `tests/config/loader.test.ts` (update to pass paths)
- Modify: `tests/config/profiles.test.ts` (update to pass paths)

- [ ] **Step 1: Update `src/config/loader.ts`**

Replace the hardcoded path constants with `PlatformPaths` parameters:

```typescript
// Key changes in loader.ts:
// 1. Remove hardcoded constants:
//    const PROJECT_CONFIG_PATH = [".omp", "supipowers", "config.json"];
//    const GLOBAL_CONFIG_DIR = ".omp";
//    const GLOBAL_CONFIG_PATH = ["supipowers", "config.json"];
//
// 2. Add PlatformPaths parameter to loadConfig, saveConfig, updateConfig:
//    export function loadConfig(cwd: string, paths: PlatformPaths): SupipowersConfig
//    export function saveConfig(cwd: string, paths: PlatformPaths, config: SupipowersConfig): void
//    export function updateConfig(cwd: string, paths: PlatformPaths, updates: Record<string, unknown>): SupipowersConfig
//
// 3. Replace path resolution:
//    getProjectConfigPath(cwd) → paths.project(cwd, "config.json")
//    getGlobalConfigPath() → paths.global("config.json")
```

Import `PlatformPaths` from `../platform/types.js`.

- [ ] **Step 2: Update `src/config/profiles.ts`**

Replace `const PROFILES_DIR = [".omp", "supipowers", "profiles"]` with a `PlatformPaths` parameter on `loadProfile`, `listProfiles`, etc. Use `paths.project(cwd, "profiles")`.

- [ ] **Step 3: Update tests**

Update `tests/config/loader.test.ts` and `tests/config/profiles.test.ts` to pass `createPaths(".test")` or `createPaths(".omp")` to the migrated functions.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/config/`
Expected: All config tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config/loader.ts src/config/profiles.ts tests/config/
git commit -m "refactor(config): use PlatformPaths for config and profile directories"
```

---

### Task 9: Storage Path Migration

Migrate all 5 storage modules. Same mechanical pattern as Task 8.

**Files:**
- Modify: `src/storage/plans.ts`, `src/storage/reports.ts`, `src/storage/runs.ts`, `src/storage/fix-pr-sessions.ts`, `src/storage/qa-sessions.ts`
- Modify: corresponding test files in `tests/storage/`

- [ ] **Step 1: Migrate each storage file**

For each file, the pattern is identical:

1. Remove the hardcoded `const XXXX_DIR = [".omp", "supipowers", "..."]`
2. Add `PlatformPaths` as a parameter to the getter function
3. Replace `path.join(cwd, ...XXXX_DIR)` with `paths.project(cwd, "...")`
4. Thread `paths` through all exported functions that use the dir

Example for `plans.ts`:
```typescript
// BEFORE
const PLANS_DIR = [".omp", "supipowers", "plans"];
function getPlansDir(cwd: string): string {
  return path.join(cwd, ...PLANS_DIR);
}
export function listPlans(cwd: string): string[] { ... }

// AFTER
import type { PlatformPaths } from "../platform/types.js";
function getPlansDir(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "plans");
}
export function listPlans(paths: PlatformPaths, cwd: string): string[] { ... }
```

Apply the same to: `reports.ts`, `runs.ts`, `fix-pr-sessions.ts`, `qa-sessions.ts`.

- [ ] **Step 2: Update storage tests**

Update `tests/storage/*.test.ts` to pass `createPaths(".test")` to all migrated functions.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/storage/`
Expected: All storage tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/storage/ tests/storage/
git commit -m "refactor(storage): use PlatformPaths for all storage directories"
```

---

### Task 10: QA / Fix-PR Path Migration

**Files:**
- Modify: `src/qa/config.ts`, `src/qa/matrix.ts`, `src/qa/session.ts`, `src/fix-pr/config.ts`
- Modify: `tests/qa/config.test.ts`, `tests/qa/matrix.test.ts`, `tests/qa/session.test.ts`, `tests/fix-pr/config.test.ts`

- [ ] **Step 1: Migrate QA and Fix-PR config files**

Same pattern as Task 9:
- `qa/config.ts`: Replace `path.join(cwd, ".omp", "supipowers", CONFIG_FILENAME)` with `paths.project(cwd, CONFIG_FILENAME)`
- `qa/matrix.ts`: Replace `path.join(cwd, ".omp", "supipowers", MATRIX_FILENAME)` with `paths.project(cwd, MATRIX_FILENAME)`
- `qa/session.ts`: Replace `path.join(cwd, ".omp", "supipowers", "qa-sessions", ...)` with `paths.project(cwd, "qa-sessions", ...)`
- `fix-pr/config.ts`: Replace `path.join(cwd, ".omp", "supipowers", CONFIG_FILENAME)` with `paths.project(cwd, CONFIG_FILENAME)`

- [ ] **Step 2: Update tests**

Pass `createPaths(".test")` to migrated functions.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/qa/ tests/fix-pr/`
Expected: All QA and fix-pr tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/qa/ src/fix-pr/ tests/qa/ tests/fix-pr/
git commit -m "refactor(qa,fix-pr): use PlatformPaths for config and session directories"
```

---

### Task 11: Visual & Context-Mode Path Migration

**Files:**
- Modify: `src/visual/companion.ts`
- Modify: `src/context-mode/hooks.ts`

- [ ] **Step 1: Migrate companion.ts**

Replace `const VISUAL_DIR = [".omp", "supipowers", "visual"]` with `PlatformPaths` parameter. Thread through exported functions.

- [ ] **Step 2: Migrate hooks.ts**

Two changes:
1. Replace `join(process.cwd(), ".omp", "supipowers", "sessions")` with `paths.project(process.cwd(), "sessions")`
2. Change function signature: `registerContextModeHooks(platform: Platform, config: SupipowersConfig)` — use `platform.on()`, `platform.getActiveTools()`, and `platform.paths`
3. Replace `pi.on("session.compacting", ...)` with `platform.on("session_compact", ...)` — the adapter handles the translation

- [ ] **Step 3: Update tests**

Update `tests/context-mode/hooks.test.ts` and `tests/visual/companion.test.ts`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/context-mode/hooks.test.ts tests/visual/companion.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/visual/companion.ts src/context-mode/hooks.ts tests/context-mode/hooks.test.ts tests/visual/companion.test.ts
git commit -m "refactor(hooks,visual): use Platform and PlatformPaths"
```

---

### Task 12: Command Migration

Migrate all 10 command files and `lsp/bridge.ts` from `ExtensionAPI` to `Platform`.

**Files:**
- Modify: `src/commands/supi.ts`, `src/commands/config.ts`, `src/commands/status.ts`, `src/commands/plan.ts`, `src/commands/run.ts`, `src/commands/review.ts`, `src/commands/qa.ts`, `src/commands/release.ts`, `src/commands/update.ts`, `src/commands/fix-pr.ts`
- Modify: `src/lsp/bridge.ts`

- [ ] **Step 1: Migrate all command files**

For each command file, the change is:

```typescript
// BEFORE
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export function registerXxxCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:xxx", { ... });
}

// AFTER
import type { Platform } from "../platform/types.js";
export function registerXxxCommand(platform: Platform): void {
  platform.registerCommand("supi:xxx", { ... });
}
```

For files that use `pi.exec()`, `pi.sendMessage()`, `pi.getActiveTools()`, `pi.getCommands()` — rename `pi` → `platform` in all call sites.

**Important:** Four command files (`supi.ts`, `config.ts`, `status.ts`, `update.ts`) also import `ExtensionContext` from `@oh-my-pi/pi-coding-agent`. Replace these with `PlatformContext` from `../platform/types.js`. The `PlatformContext` type is structurally compatible — `ctx.ui.select`, `ctx.ui.notify`, `ctx.cwd`, `ctx.hasUI` all work the same. This is a type annotation change only, no runtime behavior change.

For files with hardcoded `.omp` notification strings (qa.ts, fix-pr.ts):
```typescript
// BEFORE
ctx.ui.notify("Config saved to .omp/supipowers/fix-pr.json", "info");
// AFTER
ctx.ui.notify(`Config saved to ${platform.paths.dotDirDisplay}/supipowers/fix-pr.json`, "info");
```

For `update.ts` — use `platform.paths.agent(...)` instead of `join(homedir(), ".omp", "agent", ...)`.

For `lsp/bridge.ts` — change import from `@oh-my-pi/pi-coding-agent` to `../platform/types.js`.

- [ ] **Step 2: Run existing command tests**

Run: `npx vitest run tests/commands/`
Expected: May need test updates. Currently only `tests/commands/run.test.ts` exists — update it to pass `createMockPlatform()` instead of the old ExtensionAPI mock.

- [ ] **Step 3: Fix failing tests**

Update `tests/commands/run.test.ts` to use `createMockPlatform()` from `src/platform/test-utils.ts`. Also update `tests/integration/extension.test.ts` if it references `ExtensionAPI`.

- [ ] **Step 4: Run full test suite for commands + integration**

Run: `npx vitest run tests/commands/ tests/integration/`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/ src/lsp/bridge.ts tests/commands/
git commit -m "refactor(commands): migrate all commands from ExtensionAPI to Platform"
```

---

### Task 13: Orchestrator Migration

Migrate the dispatcher (agent session creation) and progress renderer.

**Files:**
- Modify: `src/orchestrator/dispatcher.ts`
- Modify: `src/orchestrator/progress-renderer.ts`
- Modify: `tests/orchestrator/dispatcher.test.ts`

- [ ] **Step 1: Migrate dispatcher.ts**

Key changes:
```typescript
// BEFORE
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export interface DispatchOptions {
  pi: ExtensionAPI;
  ...
}
// In executeSubAgent:
const { createAgentSession } = pi.pi;
const { session } = await createAgentSession({ ... });

// AFTER
import type { Platform } from "../platform/types.js";
export interface DispatchOptions {
  platform: Platform;
  ...
}
// In executeSubAgent:
const session = await platform.createAgentSession({
  cwd: process.cwd(),
  taskDepth: 1,
  parentTaskPrefix: `task-${task.id}`,
});
```

The `session.subscribe()`, `session.prompt()`, `session.dispose()` calls remain identical — the adapter already normalizes these.

- [ ] **Step 2: Migrate progress-renderer.ts**

Remove the local `ExtensionAPI` interface definition. Import `Platform` from `../platform/types.js`. Change `registerProgressRenderer(pi: ExtensionAPI)` to `registerProgressRenderer(platform: Platform)`.

- [ ] **Step 3: Update dispatcher tests**

Update `tests/orchestrator/dispatcher.test.ts` to use `createMockPlatform()`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/orchestrator/`
Expected: All orchestrator tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/dispatcher.ts src/orchestrator/progress-renderer.ts tests/orchestrator/
git commit -m "refactor(orchestrator): use Platform for agent sessions and rendering"
```

---

### Task 14: Prompt Text Migration

Migrate LLM-visible `.omp` path references in prompt builders.

**Files:**
- Modify: `src/qa/prompt-builder.ts`
- Modify: `src/planning/plan-writer-prompt.ts`

- [ ] **Step 1: Migrate prompt builders**

For `qa/prompt-builder.ts`:
```typescript
// BEFORE
"Last-known flow states from `.omp/supipowers/e2e-matrix.json`:"
"Update the persistent matrix at `.omp/supipowers/e2e-matrix.json`:"

// AFTER — accept dotDirDisplay as parameter
`Last-known flow states from \`${dotDirDisplay}/supipowers/e2e-matrix.json\`:`
`Update the persistent matrix at \`${dotDirDisplay}/supipowers/e2e-matrix.json\`:`
```

For `planning/plan-writer-prompt.ts`:
```typescript
// BEFORE
"Save the plan to `.omp/supipowers/plans/YYYY-MM-DD-<feature-name>.md`"

// AFTER
`Save the plan to \`${dotDirDisplay}/supipowers/plans/YYYY-MM-DD-<feature-name>.md\``
```

Thread `dotDirDisplay` (or `PlatformPaths`) through the function signatures.

- [ ] **Step 2: Update tests**

Update `tests/qa/prompt-builder.test.ts` and `tests/planning/plan-writer-prompt.test.ts`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/qa/prompt-builder.test.ts tests/planning/plan-writer-prompt.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/qa/prompt-builder.ts src/planning/plan-writer-prompt.ts tests/qa/ tests/planning/
git commit -m "refactor(prompts): use dynamic path display in LLM prompt text"
```

---

### Task 15: Package.json Update

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package.json**

Changes:
1. Bump version to `"1.0.0"`
2. Update description: `"Workflow extension for Pi and OMP coding agents."`
3. Add `"pi"` manifest field alongside `"omp"`
4. Update keywords to include `"pi-extension"`
5. Change peerDependencies: add `@mariozechner/pi-coding-agent`, make both optional
6. Add devDependency for `@mariozechner/pi-coding-agent`

```json
{
  "version": "1.0.0",
  "description": "Workflow extension for Pi and OMP coding agents.",
  "keywords": ["pi-extension", "omp-extension", "workflow", "agent", "supipowers"],
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"]
  },
  "omp": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@oh-my-pi/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  },
  "peerDependenciesMeta": {
    "@mariozechner/pi-coding-agent": { "optional": true },
    "@oh-my-pi/pi-coding-agent": { "optional": true },
    "@oh-my-pi/pi-tui": { "optional": true }
  },
  "devDependencies": {
    "@mariozechner/pi-coding-agent": "latest",
    "@mariozechner/pi-tui": "latest",
    "@oh-my-pi/pi-coding-agent": "latest",
    "@oh-my-pi/pi-tui": "latest",
    ...existing...
  }
}
```

- [ ] **Step 2: Install new dev dependency**

Run: `npm install --save-dev @mariozechner/pi-coding-agent@latest`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add Pi manifest, update deps, bump to v1.0.0"
```

---

### Task 16: Installer Rewrite

Rewrite `bin/install.mjs` for dual-platform detection.

**Files:**
- Modify: `bin/install.mjs`

- [ ] **Step 1: Add Pi binary detection**

Add `findPiBinary()` function alongside existing `findOmpBinary()`:

```javascript
function findPiBinary() {
  const check = run("pi", ["--version"]);
  if (!check.error && check.status === 0) return "pi";
  const bunPath = join(homedir(), ".bun", "bin", "pi");
  if (existsSync(bunPath)) {
    const fallback = run(bunPath, ["--version"]);
    if (!fallback.error && fallback.status === 0) return bunPath;
  }
  return null;
}
```

- [ ] **Step 2: Replace the platform detection logic in `main()`**

Replace the OMP-only check with dual detection:

```javascript
const pi = findPiBinary();
const omp = findOmpBinary();

if (pi && omp) {
  // Both found — ask user
  const target = await multiselect({
    message: "Both Pi and OMP detected. Install to:",
    options: [
      { value: "pi", label: `Pi (${piVersion})` },
      { value: "omp", label: `OMP (${ompVersion})` },
    ],
    required: true,
  });
  // Install to each selected target
} else if (pi) {
  const shouldInstall = await confirm({ message: `Install to Pi?` });
  if (shouldInstall) installToPi(pi, packageRoot);
} else if (omp) {
  const shouldInstall = await confirm({ message: `Install to OMP?` });
  if (shouldInstall) installToOmp(omp, packageRoot);
} else {
  // Neither found — offer Pi install
  note("Pi is an AI coding agent that supipowers extends.\nLearn more: https://github.com/badlogic/pi-mono", "Pi not found");
  const shouldInstall = await confirm({ message: "Install Pi now?" });
  if (shouldInstall) {
    // Install Pi via npm/bun
  }
}
```

- [ ] **Step 3: Add `installToPi()` function**

```javascript
function installToPi(piBinary, packageRoot) {
  // Option A: use pi install npm:supipowers
  // Option B: copy to ~/.pi/agent/extensions/supipowers/
  const extDir = join(homedir(), ".pi", "agent", "extensions", "supipowers");
  // Same copy logic as OMP but targeting ~/.pi/
}
```

- [ ] **Step 4: Update outro message**

```javascript
outro("supipowers is ready! Run `pi` or `omp` to start using it.");
```

- [ ] **Step 5: Test manually**

Run: `node bin/install.mjs --skip-lsp`
Expected: Detects available platforms, prompts appropriately.

- [ ] **Step 6: Commit**

```bash
git add bin/install.mjs
git commit -m "feat(installer): dual-platform detection and install flow"
```

---

### Task 17: Integration Smoke Tests

**Files:**
- Create: `tests/integration/dual-platform.test.ts`
- Modify: `tests/integration/extension.test.ts` (if it exists with OMP-specific mocks)

- [ ] **Step 1: Write dual-platform bootstrap test**

```typescript
// tests/integration/dual-platform.test.ts
import { describe, it, expect, vi } from "vitest";
import supipowers from "../../src/index.js";

function createPiShapedApi() {
  return {
    registerCommand: vi.fn(),
    getCommands: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
  };
}

function createOmpShapedApi() {
  return {
    ...createPiShapedApi(),
    pi: {
      createAgentSession: vi.fn(async () => ({
        session: {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {}),
          state: { messages: [] },
          dispose: vi.fn(async () => {}),
        },
      })),
    },
  };
}

describe("dual-platform bootstrap", () => {
  it("bootstraps on Pi-shaped API without errors", () => {
    expect(() => supipowers(createPiShapedApi())).not.toThrow();
  });

  it("bootstraps on OMP-shaped API without errors", () => {
    expect(() => supipowers(createOmpShapedApi())).not.toThrow();
  });

  it("registers commands on Pi", () => {
    const api = createPiShapedApi();
    supipowers(api);
    const commandNames = api.registerCommand.mock.calls.map((c: any) => c[0]);
    expect(commandNames).toContain("supi");
    expect(commandNames).toContain("supi:run");
    expect(commandNames).toContain("supi:plan");
  });

  it("registers input hook on both platforms", () => {
    const piApi = createPiShapedApi();
    const ompApi = createOmpShapedApi();
    supipowers(piApi);
    supipowers(ompApi);
    const piEvents = piApi.on.mock.calls.map((c: any) => c[0]);
    const ompEvents = ompApi.on.mock.calls.map((c: any) => c[0]);
    expect(piEvents).toContain("input");
    expect(ompEvents).toContain("input");
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run tests/integration/`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/dual-platform.test.ts
git commit -m "test: add dual-platform bootstrap integration tests"
```

---

### Task 18: Full Test Suite & Typecheck

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors. If there are errors, fix them — they'll be in files where `PlatformPaths` threading was incomplete.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. Fix any remaining failures from the migration.

- [ ] **Step 3: Verify no remaining `.omp` hardcoded paths in src/**

Run: `grep -rn '\.omp' src/ | grep -v 'node_modules' | grep -v '\.omp.*adapter\|dotDir\|createPaths'`
Expected: No results (all `.omp` references should be in the OMP adapter or path creation only).

- [ ] **Step 4: Verify no remaining `@oh-my-pi` imports in src/** (except omp adapter)

Run: `grep -rn '@oh-my-pi' src/ | grep -v 'platform/omp'`
Expected: No results.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve remaining typecheck and test failures from migration"
```

---

### Task 19: Final Commit & Tag

- [ ] **Step 1: Run full verification**

Run: `npm run typecheck && npm test`
Expected: Both pass cleanly.

- [ ] **Step 2: Clean up the old gap analysis doc**

The `docs/omp-vs-pi-gap-analysis.md` was research — keep it or remove it per preference.

- [ ] **Step 3: Final commit if needed**

```bash
git add -A
git commit -m "v1.0.0: dual-platform support for Pi and OMP"
```

- [ ] **Step 4: Tag the release**

```bash
git tag v1.0.0
```
