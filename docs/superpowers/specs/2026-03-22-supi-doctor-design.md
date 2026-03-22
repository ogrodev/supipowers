# `/supi:doctor` — Extension Health Check

## Purpose

A diagnostic command that verifies all supipowers features are accessible and working. Two-phase checks (presence then functional) report transparently what was found, so users know exactly what will and won't work on their platform.

## Command Registration

- Name: `supi:doctor`
- Type: TUI-only (intercepted at input level, no chat message or "Working..." indicator)
- File: `src/commands/doctor.ts`
- Registration: added to `TUI_COMMANDS` in `bootstrap.ts`
- Handler signature: `(platform: Platform, ctx: any) => void` — wraps async logic in `void (async () => { ... })()`

## Check Result Shape

```typescript
interface CheckResult {
  name: string;
  presence: { ok: boolean; detail: string };
  functional?: { ok: boolean; detail: string };
}

type SectionResult = { title: string; checks: CheckResult[] };
```

Each check function is async and returns a `CheckResult`. Checks run sequentially within a section (some depend on presence passing before attempting functional). Sections run sequentially to keep output ordered.

## Checks

### Section 1: Core Infrastructure

| Check | Presence | Functional |
|-------|----------|------------|
| Platform | Report detected platform name (Pi/OMP) | Run `platform.exec("echo", ["ok"])` to verify exec works |
| Config | Check if config file exists at `platform.paths.project(cwd, "config.json")` and `platform.paths.global("config.json")` | Parse with `loadConfig(platform.paths, cwd)`, report `config.defaultProfile` |
| Storage | Check if project storage dir exists at `platform.paths.project(cwd)` | Create and delete a temp file to verify writable |
| EventStore | Try dynamic `import("better-sqlite3")` | Open in-memory Database, exec `CREATE VIRTUAL TABLE ... USING fts5(...)`, close |
| Git | Run `git --version`, parse version string | Run `git rev-parse --is-inside-work-tree` and `git branch --show-current` |

### Section 2: Integrations

| Check | Presence | Functional |
|-------|----------|------------|
| GitHub CLI | Run `gh --version`, parse version string | Run `gh auth status`, parse username from stderr output |
| LSP | Check `platform.getActiveTools()` for tools containing `"lsp"` (case-insensitive) | Presence-only (no lightweight way to ping LSP) |
| MCP | Check if any tool in `platform.getActiveTools()` starts with `mcp__` | Count MCP tools, extract unique server names from `mcp__<server>__<tool>` pattern |
| Context Mode | Use `detectContextMode(activeTools)` from `src/context-mode/detector.ts` | Report which ctx tools are available from the returned `ContextModeStatus.tools` |
| npm | Run `npm --version`, parse version string | Run `npm ping`, check exit code |

### Section 3: Platform Capabilities

Read `platform.capabilities` and map each to the features that depend on it:

| Capability | Feature Impact |
|------------|---------------|
| `agentSessions` | Sub-agent orchestration (`/supi:run`) |
| `compactionHooks` | Context compression hooks |
| `customWidgets` | Progress widgets and status line |
| `registerTool` | Custom tool registration |
| MCP (detected) | Context-mode, MCP tools |

MCP is not in `PlatformCapabilities` — it's derived from the active tools detection done in Section 2. The doctor reuses that result here.

## Output Format

All checks run first, results are collected into `SectionResult[]`, then the full report is rendered at once via a single `ctx.ui.notify()` call with the formatted multi-line string. This avoids pacing issues and ensures the output appears as one coherent block.

```
/supi:doctor

Core Infrastructure
  Platform .......... ✓ OMP detected
                      ✓ exec works
  Config ............ ✓ Found .omp/supipowers/config.json
                      ✓ Parsed (defaultProfile: thorough)
  Storage ........... ✓ .omp/supipowers/ exists
                      ✓ Writable
  EventStore ........ ✓ better-sqlite3 available
                      ✓ SQLite + FTS5 functional
  Git ............... ✓ v2.43.0
                      ✓ Repo detected (feat/dual-platform)

Integrations
  GitHub CLI ........ ✓ v2.62.0
                      ✓ Authenticated (pedromendes)
  LSP ............... ✓ LSP tools detected
  Context Mode ...... ✓ Tools available (ctx_execute, ctx_search, ...)
  MCP ............... ✓ Active (12 tools, 3 servers)
  npm ............... ✓ v10.8.0
                      ✓ Registry reachable

Platform Capabilities
  agentSessions ..... ✓ Sub-agent orchestration (/supi:run)
  compactionHooks ... ✓ Context compression
  customWidgets ..... ✓ Progress widgets
  registerTool ...... ✗ Not available — custom tools disabled
  MCP ............... ✓ Detected via active tools

Summary: 15 passed, 1 warning, 0 critical
```

## Summary Line Logic

- **Passed**: check where both presence and functional (if present) are `ok: true`
- **Warning**: check where presence passes but functional fails, or a non-critical capability is missing
- **Critical**: check where presence fails for a core infrastructure item (Platform, Config, Git)

## Implementation Notes

- All shell commands use `platform.exec()` — no direct `child_process` imports
- Config loading reuses `loadConfig(platform.paths, cwd)` from `src/config/loader.ts`
- EventStore check uses dynamic `import("better-sqlite3")` to avoid crashing if missing
- Context-mode detection reuses `detectContextMode()` from `src/context-mode/detector.ts`
- MCP server names extracted by splitting tool names on `__` — e.g., `mcp__plugin_figma_figma__get_screenshot` yields server `plugin_figma_figma`
- `platform.getActiveTools()` is called once and the result is shared across LSP, MCP, and context-mode checks
- No new dependencies required
- Guard with `ctx.hasUI` — in non-interactive modes, return early (no output)

## What It Does Not Do

- No optional capability checks (Playwright, test frameworks, visual companion)
- No auto-fix or remediation
- No network-heavy operations beyond `npm ping` and `gh auth status`
- No persistent storage of results
