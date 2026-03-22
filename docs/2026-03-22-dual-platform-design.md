# Dual-Platform Abstraction Layer — Design Spec

**Date:** 2026-03-22
**Version:** 1.0.0
**Status:** Approved

## 1. Problem

Supipowers is currently OMP-only. It imports from `@oh-my-pi/pi-coding-agent`, installs to `~/.omp/agent/extensions/`, and uses OMP-specific API conventions. Users on Pi (the primary open-source coding agent by @mariozechner) cannot use supipowers at all.

Pi and OMP share ~90% of the same Extension API surface, but differ in:

- Package names (`@mariozechner/pi-coding-agent` vs `@oh-my-pi/pi-coding-agent`)
- Event return shapes (`{ action: "handled" }` vs `{ handled: true }`)
- Agent session creation (`AgentSession` direct import vs `pi.pi.createAgentSession()`)
- Compaction event names (Pi: `session_before_compact` + `session_compact` vs OMP: `session_before_compact` + `session.compacting`)
- Config/install paths (`~/.pi/` vs `~/.omp/`)
- `sendMessage` options (`{ deliverAs, triggerTurn }` vs OMP's shape)

## 2. Goals

1. **Single npm package** installable on both Pi and OMP
2. **Pi is primary** — interface mirrors Pi's API shape, Pi adapter is near pass-through
3. **OMP is maintenance mode** — existing features preserved, no new OMP-only work
4. **Native Pi distribution** — `pi install npm:supipowers` just works
5. **Zero new dependencies** — adapters use only what each platform SDK provides
6. **No breaking changes** to user-facing commands
7. **Version 1.0.0** — marks the Pi-first era

## 3. Non-Goals

- No new features in this release (purely structural migration)
- No OMP feature parity improvements
- No changes to skills, quality gates, or business logic
- Prompt builders and storage modules receive only path-resolution changes (`.omp` → `platform.paths`), no behavioral changes

## 4. Architecture

```
┌───────────────────────────────────────────────┐
│              supipowers v1.0.0                 │
│                                               │
│  src/index.ts (detect → create adapter)       │
│  src/bootstrap.ts (register all features)     │
│                                               │
│  src/commands/*.ts ──┐                        │
│  src/orchestrator/ ──┤── all talk to Platform  │
│  src/context-mode/ ──┘                        │
│                                               │
│  src/platform/                                │
│    types.ts    ← Platform interface           │
│    detect.ts   ← runtime detection            │
│    pi.ts       ← Pi adapter (pass-through)    │
│    omp.ts      ← OMP adapter (translates)     │
│    test-utils.ts ← mock factory for tests     │
└───────────────────────────────────────────────┘
```

Runtime flow:

1. Pi or OMP loads `src/index.ts`, calling `supipowers(rawApi)`
2. `detectPlatform(rawApi)` inspects the API object — OMP exposes `rawApi.pi.createAgentSession`, Pi does not
3. The appropriate adapter factory (`createPiAdapter` or `createOmpAdapter`) wraps the raw API into a `Platform` instance
4. `bootstrap(platform)` registers all commands, hooks, and renderers against the `Platform` interface

## 5. Platform Interface

The canonical interface mirrors Pi's API shape. All extension code talks to this — never to OMP or Pi directly.

```typescript
// src/platform/types.ts

export interface Platform {
  // Identity
  name: "pi" | "omp";

  // Commands
  registerCommand(name: string, opts: CommandOptions): void;
  getCommands(): CommandInfo[];

  // Events (Pi conventions are canonical)
  on(event: "input", handler: InputHandler): void;
  on(event: "session_start", handler: SessionStartHandler): void;
  on(event: "tool_call", handler: ToolCallHandler): void;
  on(event: "tool_result", handler: ToolResultHandler): void;
  on(event: "before_agent_start", handler: BeforeAgentStartHandler): void;
  on(event: "session_before_compact", handler: CompactHandler): void;
  on(event: "session_compact", handler: PostCompactHandler): void;

  // Execution
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  sendMessage(content: MessagePayload, opts?: SendMessageOptions): void;

  // Introspection
  getActiveTools(): string[];

  // Rendering
  registerMessageRenderer<T>(type: string, renderer: MessageRenderer<T>): void;

  // Agent Sessions
  createAgentSession(opts: AgentSessionOptions): Promise<AgentSession>;

  // Paths — centralized resolution for all platform-specific directories
  paths: PlatformPaths;

  // Capabilities
  capabilities: PlatformCapabilities;
}

export interface PlatformPaths {
  /** The dot-directory name: ".pi" or ".omp" */
  dotDir: string;
  /** Resolve a project-local supipowers path: e.g., paths.project(cwd, "plans") → "<cwd>/.pi/supipowers/plans" */
  project(cwd: string, ...segments: string[]): string;
  /** Resolve a global supipowers path: e.g., paths.global("config.json") → "~/.pi/supipowers/config.json" */
  global(...segments: string[]): string;
  /** Resolve the agent-level install path: e.g., paths.agent("extensions", "supipowers") → "~/.pi/agent/extensions/supipowers" */
  agent(...segments: string[]): string;
  /** The dot-dir string for use in user-visible messages and LLM prompts */
  dotDirDisplay: string;
}

export interface PlatformCapabilities {
  agentSessions: boolean;
  compactionHooks: boolean;
  customWidgets: boolean;
  registerTool: boolean;
}

export interface AgentSession {
  subscribe(handler: (event: AgentEvent) => void): () => void;
  prompt(text: string, opts?: PromptOptions): Promise<void>;
  state: { messages: any[] };
  dispose(): Promise<void>;
}

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
```

**How `PlatformContext` flows:** Event handlers and command handlers receive `ctx` as a second parameter from the underlying platform. Both Pi and OMP pass `(event, ctx)` to handlers. The adapters do NOT wrap `ctx` — the `PlatformUI` interface is structurally compatible with both Pi's and OMP's `ctx.ui`. The `PlatformContext` type is used for type annotations in consuming code, not as a runtime wrapper. Command handler signatures become `handler(args, ctx: PlatformContext)`.

The `platform.paths` object is accessed via the `Platform` instance (not through `ctx`). Functions that need both UI and paths receive `platform` or destructure what they need:

## 6. Platform Detection

```typescript
// src/platform/detect.ts

export type PlatformType = "pi" | "omp";

export function detectPlatform(rawApi: any): PlatformType {
  // OMP nests its internal API under rawApi.pi
  if (rawApi.pi && typeof rawApi.pi.createAgentSession === "function") {
    return "omp";
  }
  return "pi";
}
```

## 7. Adapters

### Pi Adapter (primary — near pass-through)

The Pi adapter is thin since the Platform interface mirrors Pi's conventions:

- `registerCommand`, `getCommands`, `getActiveTools`, `exec`, `registerMessageRenderer` — direct pass-through
- `on()` — direct pass-through (Pi event shapes are canonical)
- `sendMessage` — maps to Pi's `{ deliverAs, triggerTurn }` options
- `createAgentSession` — dynamic import from `@mariozechner/pi-coding-agent`, wraps result into `AgentSession` interface

### OMP Adapter (translates to Platform conventions)

The OMP adapter handles four concrete translations:

| Concern | Platform (Pi shape) | OMP shape | Adapter action |
|---------|-------------------|-----------|----------------|
| Input event return | `{ action: "handled" }` | `{ handled: true }` | Translate return value |
| Compaction pre-event | `"session_before_compact"` | `"session_before_compact"` | Pass-through (same name, but return shape may differ) |
| Compaction post-event | `"session_compact"` | `"session.compacting"` | Map event name |
| Agent session creation | `platform.createAgentSession()` | `pi.pi.createAgentSession()` | Route to nested API |
| Paths | `platform.paths.project(cwd, "plans")` → `.pi/supipowers/plans` | Same call → `.omp/supipowers/plans` | Adapter sets `dotDir: ".omp"` |

All other APIs pass through directly — registerCommand, exec, sendMessage, getActiveTools, getCommands, registerMessageRenderer, and most event hooks are identical.

## 8. Entry Point & Bootstrap

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

`bootstrap()` contains all the registration logic currently in `index.ts`: command registration, progress renderer, input interceptor, context-mode hooks, and session-start hooks. It speaks only to `Platform`.

## 9. Package Structure & Distribution

### package.json

```json
{
  "name": "supipowers",
  "version": "1.0.0",
  "description": "Workflow extension for Pi and OMP coding agents.",
  "type": "module",
  "keywords": ["pi-extension", "omp-extension", "workflow", "agent"],
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
    "@sinclair/typebox": "*"
  },
  "peerDependenciesMeta": {
    "@mariozechner/pi-coding-agent": { "optional": true },
    "@oh-my-pi/pi-coding-agent": { "optional": true }
  }
}
```

### Installation methods

| Method | Command | How it works |
|--------|---------|-------------|
| Pi native (recommended) | `pi install npm:supipowers` | Pi reads `"pi"` field, discovers extension + skills |
| OMP (existing) | `npx supipowers` | Installer copies to `~/.omp/agent/extensions/` |
| Project-local | `npm install supipowers` | Auto-discovered from `node_modules` |

### Installer (`bin/install.mjs`) — dual-platform

Detection logic:

1. Check for `pi` binary in PATH → Pi detected
2. Check for `omp` binary in PATH → OMP detected
3. If both: ask user which to install to (can choose both)
4. If one: confirm install to that platform
5. If neither: offer to install Pi (not OMP)

For Pi installs: run `pi install npm:supipowers` or copy to `~/.pi/agent/extensions/supipowers/`.
For OMP installs: existing copy-to-`~/.omp/` logic preserved.

## 10. Centralized Path Resolution

### The problem

Hardcoded `.omp` paths appear in **20 locations across 17 files** — not just config:

| Category | Files | Example path |
|----------|-------|-------------|
| Config | `config/loader.ts`, `config/profiles.ts` | `.omp/supipowers/config.json` |
| Storage | `storage/plans.ts`, `storage/reports.ts`, `storage/runs.ts`, `storage/fix-pr-sessions.ts`, `storage/qa-sessions.ts` | `.omp/supipowers/plans/` |
| QA | `qa/config.ts`, `qa/matrix.ts`, `qa/session.ts` | `.omp/supipowers/e2e-matrix.json` |
| Fix-PR | `fix-pr/config.ts` | `.omp/supipowers/fix-pr.json` |
| Context-mode | `context-mode/hooks.ts` | `.omp/supipowers/sessions/` |
| Visual | `visual/companion.ts` | `.omp/supipowers/visual/` |
| Commands | `commands/update.ts`, `commands/qa.ts`, `commands/fix-pr.ts` | User-facing notification strings |
| Prompt text | `qa/prompt-builder.ts`, `planning/plan-writer-prompt.ts` | LLM-visible path references |
| Entry point | `index.ts` | `~/.omp/agent/extensions/supipowers/package.json` |

### The solution: `PlatformPaths`

The `Platform` interface includes a `paths` property that all files use instead of hardcoded strings:

```typescript
// Pi adapter sets:
paths: {
  dotDir: ".pi",
  dotDirDisplay: ".pi",
  project: (cwd, ...seg) => join(cwd, ".pi", "supipowers", ...seg),
  global: (...seg) => join(homedir(), ".pi", "supipowers", ...seg),
  agent: (...seg) => join(homedir(), ".pi", "agent", ...seg),
}

// OMP adapter sets:
paths: {
  dotDir: ".omp",
  dotDirDisplay: ".omp",
  project: (cwd, ...seg) => join(cwd, ".omp", "supipowers", ...seg),
  global: (...seg) => join(homedir(), ".omp", "supipowers", ...seg),
  agent: (...seg) => join(homedir(), ".omp", "agent", ...seg),
}
```

### Migration pattern for each file type

**Storage/config files** (mechanical — replace path constant):
```typescript
// BEFORE
const PLANS_DIR = [".omp", "supipowers", "plans"];
const dir = path.join(cwd, ...PLANS_DIR);

// AFTER — receives platform.paths
function getPlansDir(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "plans");
}
```

**User-visible notification strings** (replace hardcoded `.omp`):
```typescript
// BEFORE
ctx.ui.notify("Config saved to .omp/supipowers/fix-pr.json", "info");

// AFTER
ctx.ui.notify(`Config saved to ${platform.paths.dotDirDisplay}/supipowers/fix-pr.json`, "info");
```

**LLM prompt text** (replace path references in prompts):
```typescript
// BEFORE
"Save the plan to `.omp/supipowers/plans/YYYY-MM-DD-<feature-name>.md`"

// AFTER
`Save the plan to \`${platform.paths.dotDirDisplay}/supipowers/plans/YYYY-MM-DD-<feature-name>.md\``
```

### Config path summary

| Platform | Project config | Global config | Agent dir |
|----------|---------------|---------------|-----------|
| Pi | `.pi/supipowers/config.json` | `~/.pi/supipowers/config.json` | `~/.pi/agent/` |
| OMP | `.omp/supipowers/config.json` | `~/.omp/supipowers/config.json` | `~/.omp/agent/` |

## 11. Migration Impact

The codebase has **74 `.ts` files** in `src/`. The migration touches more files than initially estimated due to pervasive hardcoded `.omp` paths.

### Files changed

| Category | Count | Change type |
|----------|-------|-------------|
| **New platform files** | 6 | `platform/types.ts`, `platform/detect.ts`, `platform/pi.ts`, `platform/omp.ts`, `platform/paths.ts`, `platform/test-utils.ts` |
| **New bootstrap** | 1 | `bootstrap.ts` extracted from `index.ts` |
| **Entry point** | 1 | `index.ts` rewritten |
| **Commands** | 10 | Rename `pi` → `platform`, change import |
| **Orchestrator** | 2 | `dispatcher.ts`, `progress-renderer.ts` |
| **Context-mode** | 1 | `hooks.ts` — normalize event names + paths |
| **Config** | 2 | `loader.ts`, `profiles.ts` — use `platform.paths` |
| **Storage** | 5 | `plans.ts`, `reports.ts`, `runs.ts`, `fix-pr-sessions.ts`, `qa-sessions.ts` — use `platform.paths` |
| **QA** | 4 | `config.ts`, `matrix.ts`, `session.ts`, `prompt-builder.ts` — use `platform.paths` |
| **Fix-PR** | 1 | `config.ts` — use `platform.paths` |
| **Visual** | 1 | `companion.ts` — use `platform.paths` |
| **LSP** | 1 | `bridge.ts` — change `ExtensionAPI` import |
| **Planning** | 1 | `plan-writer-prompt.ts` — use `platform.paths.dotDirDisplay` in prompt text |
| **Installer** | 1 | `install.mjs` — dual-platform rewrite |
| **Package manifest** | 1 | `package.json` — add `pi` field, bump to 1.0.0 |
| **Tests** | ~5 | Adapter tests + update existing mocks |
| **Total changed** | **~43** | |
| **Untouched** | **~31** | Pure business logic with no path or API references |

### What does NOT change

- Shared types (`src/types.ts`) — no platform dependency
- Skills (`skills/*/SKILL.md`) — pure markdown, platform-independent
- Git helpers (`git/base-branch.ts`, `git/sanitize.ts`, `git/worktree.ts`, `git/branch-finish.ts`)
- Quality gate runners (`quality/gate-runner.ts`, `quality/lsp-gate.ts`, `quality/test-gate.ts`, `quality/ai-review-gate.ts`)
- Batch scheduler (`orchestrator/batch-scheduler.ts`, `orchestrator/result-collector.ts`, `orchestrator/conflict-resolver.ts`)
- Agent prompts (`orchestrator/prompts.ts`, `orchestrator/agent-prompts.ts`, `orchestrator/agent-grid.ts`)
- Release logic (`release/analyzer.ts`, `release/notes.ts`, `release/publisher.ts`)
- Notification formatting (`notifications/renderer.ts`, `notifications/types.ts` — uses structural typing)
- Discipline modules (`discipline/tdd.ts`, `discipline/verification.ts`, `discipline/debugging.ts`, `discipline/receiving-review.ts`)
- LSP setup (`lsp/setup-guide.ts`, `lsp/detector.ts`)
- Context-mode utilities (`context-mode/event-extractor.ts`, `context-mode/event-store.ts`, `context-mode/compressor.ts`, `context-mode/snapshot-builder.ts`, `context-mode/routing.ts`, `context-mode/detector.ts`)

## 12. Testing Strategy

### New tests

| Test file | What it verifies |
|-----------|-----------------|
| `tests/platform/detect.test.ts` | `detectPlatform()` with Pi-shaped and OMP-shaped mock objects |
| `tests/platform/omp-adapter.test.ts` | Input event normalization, compaction event mapping, agent session wrapping |
| `tests/platform/pi-adapter.test.ts` | Pass-through verification |
| `tests/integration/dual-platform.test.ts` | Both platform shapes bootstrap without errors |

### Mock factory

`src/platform/test-utils.ts` provides `createMockPlatform()` and `createMockContext()` — drop-in replacements for existing test mocks. Existing command tests swap their mock source with minimal changes.

### What does NOT need new tests

- Individual commands — existing tests remain valid, just swap mock import
- Business logic — untouched, existing tests pass as-is

## 13. Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pi `AgentSession` API differs from expected | Medium | High | Dynamic import + adapter wrapping. Test both paths. |
| `sendMessage` options differ subtly | Low | Medium | Adapter normalizes. Integration test covers. |
| Undiscovered API differences at runtime | Low | Medium | Smoke tests on both platform shapes |
| OMP users break on upgrade | Low | Low | OMP adapter preserves exact current behavior |
| Pi doesn't load `"pi"` field from `node_modules` packages | Low | Medium | Fall back to `pi install` flow |
| `/supi:update` command needs platform-aware update logic | Medium | Low | Pi: `pi install npm:supipowers@latest`. OMP: existing npm download flow. Adapter handles. |
| Hardcoded `.omp` in LLM prompt text causes confusion on Pi | Medium | Low | Use `platform.paths.dotDirDisplay` in all prompt-builder strings |

## 14. Strategic Direction

- **Pi is primary** — new features target Pi first
- **OMP is maintenance** — existing features preserved, easy fixes accepted
- **Single npm package** — one `npm publish` serves both platforms
- **Native Pi distribution** — `pi install npm:supipowers` is the recommended install path
- **The Platform interface is the growth layer** — progressively build OMP-quality experiences into the Pi adapter
