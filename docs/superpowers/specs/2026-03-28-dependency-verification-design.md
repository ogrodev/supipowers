# Dependency Verification System

**Date:** 2026-03-28
**Status:** Approved

## Problem

Supipowers depends on several external tools (git, bun:sqlite/FTS5, mcpc, context-mode, LSP servers) but never verifies their presence during install or update. Users discover missing dependencies only when a feature fails at runtime. The install path (`bin/install.mjs`) handles LSP servers separately, and the update path (`/supi:update`) does no dependency checking at all.

## Goals

- Single source of truth for all external dependencies
- Verify deps at both install (bunx) and update (`/supi:update`) time
- Auto-install what we can, report what we can't with manual instructions
- Skip deps that are already installed — no re-prompting
- Interactive TUI experience in both entry points (OMP `ctx.ui` for update, `@clack/prompts` for CLI install)
- Zero LLM token cost — pure UI/TypeScript command

## Non-Goals (v1)

- No version pinning or lock file — installed means installed
- No automatic tool updates — only on explicit "reinstall all"
- No background checks during normal sessions
- No changes to `mcpc.autoInstall()` runtime fallback

## Dependency Registry

### Module: `src/deps/registry.ts`

Central registry defining every external tool supipowers needs.

### Types

```typescript
interface Dependency {
  name: string;            // human-readable, e.g. "Git"
  binary: string;          // what to look for, e.g. "git"
  required: boolean;       // true = supipowers won't work without it
  category: "core" | "mcp" | "lsp";
  description: string;     // one-liner about why it's needed
  checkFn: (exec: ExecFn) => Promise<{ installed: boolean; version?: string }>;
  installCmd: string | null; // null = can't auto-install
  url: string;             // manual install link
}

interface DependencyStatus extends Dependency {
  installed: boolean;
  version?: string;
}

interface InstallResult {
  name: string;
  success: boolean;
  error?: string;
}
```

### Exports

```typescript
scanAll(exec: ExecFn): Promise<DependencyStatus[]>
scanMissing(exec: ExecFn): Promise<DependencyStatus[]>
installDep(exec: ExecFn, name: string): Promise<InstallResult>
installAll(exec: ExecFn, deps: DependencyStatus[]): Promise<InstallResult[]>
formatReport(results: InstallResult[], statuses: DependencyStatus[]): string
```

### Dependency Table

| Name | Binary | Required | Category | Install Command | URL |
|---|---|---|---|---|---|
| Git | `git` | yes | core | null (can't auto-install) | https://git-scm.com |
| bun:sqlite + FTS5 | (runtime check) | yes | core | null (requires Bun runtime) | https://bun.sh |
| mcpc | `mcpc` | no | mcp | `npm install -g @apify/mcpc` | https://github.com/apify/mcpc |
| context-mode | `context-mode` | no | mcp | `npm install -g context-mode` | https://github.com/context-mode/context-mode |
| TypeScript LSP | `typescript-language-server` | no | lsp | `bun add -g typescript-language-server typescript` | https://github.com/typescript-language-server/typescript-language-server |
| Pyright | `pyright` | no | lsp | `pip install pyright` | https://github.com/microsoft/pyright |
| rust-analyzer | `rust-analyzer` | no | lsp | `rustup component add rust-analyzer` | https://rust-analyzer.github.io |
| gopls | `gopls` | no | lsp | `go install golang.org/x/tools/gopls@latest` | https://pkg.go.dev/golang.org/x/tools/gopls |

### Check Functions

- **Most deps:** `which <binary>` via exec, version from `<binary> --version`
- **bun:sqlite:** Runtime test — create in-memory Database, try `CREATE VIRTUAL TABLE ... USING fts5(...)`. Reuses the pattern from `doctor.ts`.
- **git:** `git --version` (also validates it's functional, not just present)

## `/supi:update` — TUI Command

**Type:** Pure UI/Config (zero LLM tokens). Registered as OMP extension command via `pi.registerCommand`. Intercepted at `input` event level for instant feel (no "Working..." spinner).

### Flow

1. **Scan** — call `scanAll()` silently, compute missing count
2. **Present mode selection:**
   ```
   Supipowers Update
   ├── Update supipowers only
   ├── Update supipowers + install missing tools (3 missing)
   ├── Update supipowers + reinstall all tools (latest)
   └── Cancel
   ```
   If nothing is missing, the second option shows "(all installed)".
3. **Execute chosen mode:**
   - **Supipowers only:** Download latest from npm, copy files (existing logic from `update.ts`)
   - **Install missing:** Update supipowers, then run `installDep()` for each missing dep
   - **Reinstall all:** Update supipowers, then run `installDep()` for every dep with a non-null `installCmd`
4. **Report** — show summary via `ctx.ui.notify`:
   ```
   Update complete:
     supipowers: v1.0.0 → v1.1.0
     mcpc: installed (v1.2.0)
     typescript-language-server: installed
     git: already installed (v2.43)
     pyright: SKIPPED — install manually: pip install pyright
              https://github.com/microsoft/pyright
   ```
   For deps that failed or can't be auto-installed, show the manual command and URL.

### Error Handling

- If a required dep (git, bun:sqlite) is missing and can't be auto-installed, the report highlights it prominently but doesn't block the update — supipowers files are still copied.
- Individual install failures don't stop the rest — all deps are attempted, failures collected into the report.

## `bin/install.mjs` → `bin/install.ts`

Convert the CLI install script from plain JS to TypeScript so it can share the registry directly. The `package.json` `bin` field points to a thin `.mjs` shim that runs `bun bin/install.ts`.

### Flow Changes

The existing install flow stays the same (detect Pi/OMP, copy files, register context-mode) but the LSP-specific step is replaced with the unified dependency flow:

1. After copying supipowers files and registering context-mode MCP
2. Run `scanAll()` — if everything is installed, show "All dependencies satisfied" and finish
3. If things are missing, present two options:
   - **Install supipowers + missing tools** (default)
   - **Skip dependency installation**
4. On skip or failures, show the same CLI report with manual instructions

No "reinstall all" option at initial install — that's only for `/supi:update`.

## Files Changed

| File | Change |
|---|---|
| `src/deps/registry.ts` | **New** — dependency definitions + scan/install/report functions |
| `src/commands/update.ts` | **Rewrite** — TUI command using registry, `ctx.ui.select` for mode, runs scan + install |
| `bin/install.mjs` → `bin/install.ts` | **Refactor** — remove inline LSP logic, import from registry. Thin `.mjs` shim for bin entry |
| `src/commands/doctor.ts` | **Simplify** — delegate dep checks to registry's `checkFn` where applicable |
| `src/context-mode/installer.ts` | **Thin out** — check/install logic moves to registry entry for context-mode |
| `src/mcp/mcpc.ts` | No change — `autoInstall()` stays as runtime fallback |

## Testing

- Unit tests for `src/deps/registry.ts`: mock exec, verify scan/install/report logic
- Update existing `doctor.test.ts` if checks are refactored to use registry
- Manual testing of both entry points (bunx install + `/supi:update` TUI)
