# Changelog

All notable changes to supipowers are documented in this file.

## [1.3.0] — 2026-04-10

### Features

- Add /supi:optimize-context token analysis command
- Add system prompt analyzer and tech stack context report builder
- Persist resume snapshots to DB; track compaction metadata in hooks
- Reference-based resume snapshot with ctx_search query hints

### Improvements

- Remove full-file read block; expand HTTP routing patterns
- Head+tail read compression preserving hashline anchors
- Use PRIORITY constants; extract rule and skill event categories
- Numeric EventPriority, session meta, resume persistence in event-store

### Maintenance

- Remove read-block policy; document automatic head+tail compression

## [1.2.6] — 2026-04-05

### Features

- Display commit model override in status bar during commit flow
- Show active model override in footer status bar
- Add thinking column to model dashboard
- Register model actions and apply override in all command handlers
- Re-apply model override on plan execution handoff
- Resolve model for commit sub-agent and validate staged files
- Add applyModelOverride with auto-restore on agent_end

### Fixes

- Pass actionId to applyModelOverride in all command handlers

### Improvements

- Remove inline ModelPref config; route model via model-resolver
- Make setModel async and add setThinkingLevel to Platform

### Maintenance

- Cover status bar behavior and updated applyModelOverride signature
- Add supipowers install log
- Add @oh-my-pi/pi-ai as dev and optional peer dependency
- Add applyModelOverride suite and fix bun:test imports

## [1.2.5] — 2026-04-04

### Features

- Add --debug flag with structured install log
- Add Windows local-install script (PowerShell)

### Fixes

- Always pass --force when invoked via bunx/npx
- Forced local installs to reinstall missing deps
- Add natives-test to ignored files
- Strip devDeps from installed package.json and drop --frozen-lockfile
- Update registry and tests for revised dependency model

### Maintenance

- Run installer with --debug in local-install scripts
- Remove leaked natives-test fixture directories

## [1.2.4] — 2026-04-04

### Fixes

- Run bun install in ext dir after copy to resolve runtime imports

### Maintenance

- Declare pi-ai and typebox as optional peer deps

## [1.2.3] — 2026-04-04

### Features

- Add release as valid conventional commit type
- Add skipTag option to executeRelease
- Add isTagOnRemote to distinguish local-only tags

### Fixes

- Add Windows compatibility to installer binary lookup and spawn
- Use 'where' instead of 'which' on Windows in checkBinary
- Handle local-only tag (push interrupted) as resumable release

### Maintenance

- Update invalid-type rejection test to use unknown type
- Verify checkBinary uses platform-correct lookup command
- Update isInProgressRelease test for local-only tag case
- Add tests for isTagOnRemote and skipTag executor behaviour

## [1.2.2] — 2026-04-04

### Fixes

- Use conventional chore(release) commit type in release flow

### Features

- Skip confirmation when resuming a staged unreleased release

### Refactor

- Extract commitStaged shared primitive from commit.ts

### Tests

- Update executor snapshot to chore(release) commit message
- Add commitStaged unit tests

## [1.2.1] — 2026-04-04

### Fixes

- Exclude binary artifacts and visual server deps from npm package
- Route post-approval user message through platform, not ctx

### Features

- Add sendUserMessage to Platform interface and adapters

### Docs

- Rewrite README for OMP-only scope and current command set

### Tests

- Update approval-flow tests for captured newSession and platform.sendUserMessage

## [1.2.0] — 2026-04-03

### Features

- Skip version bump when local version is unreleased
- Add skipBump option to executeRelease
- Add isVersionReleased to detect existing git tags
- Add live progress widget to supi:release command
- Add ReleaseProgressFn and onProgress to executeRelease
- Add error field to ReleaseResult for pre-channel failures
- Wire args passthrough and add supi:commit to TUI dispatch table
- Add rich progress tracker with spinner and widget panel
- Add plan approval flow via agent_end hook
- Improve context analyzer and /supi:context output
- Auto-detect bot reviewers from GitHub API user type
- Improve MCP config discovery and migration command
- Extract commit-types module and enhance changelog generation
- Add /supi:commit with convention validation and commit-msg hook
- Add supi:context to overview menu
- Wire supi:context into bootstrap TUI_COMMANDS
- Add handleContext command handler and registerContextCommand
- Add buildBreakdown for TUI display formatting
- Add parseSystemPrompt with XML and heading extraction
- Add estimateTokens and formatSize utilities

### Fixes

- Skip git add+commit when skipBump is true
- Include stdout in git/publish error details
- Update bootstrap and mcp config for OMP runtime
- Update release command for current platform API
- Update status, release, and doctor commands for OMP-only

### Improvements

- Overhaul approval-flow and add comprehensive test suite
- Move execution to TUI handler, register as no-op for autocomplete
- Update dependency registry for removed modules
- Clean up plans storage layer
- Remove model-config module and unused config command
- Remove /supi:run command and orchestrator subsystem
- Remove Pi adapter and go OMP-only
- Update shared types for OMP-only architecture

### Maintenance

- Migrate test runner from vitest to bun:test
- Port all test files to bun:test
- Add progress widget lifecycle and early-exit cleanup coverage
- Update planning and release skill prompts
- Update context-mode and extension integration tests
- Register /supi:commit and update extension entry point
- Add supi:context to integration smoke test
- Add heading section and edge case tests for parseSystemPrompt
- Add supi:context design spec

## [1.1.0] — 2026-03-30

### Features

- Redesigned /supi:release as a programmatic pipeline — zero LLM tokens for standard releases
- Conventional commit parsing + markdown changelog generation
- Semver bump suggestion with UI confirmation
- Channel auto-detection (GitHub CLI + npm)
- Multi-channel setup (github + npm simultaneously)
- Programmatic release execution with --dry-run support
- Optional --polish flag for LLM-assisted note polishing

### Changes

- Config migration: release.pipeline → release.channels (automatic)
- New modules: changelog.ts, version.ts, detector.ts, executor.ts, prompt.ts
- Deleted old LLM prompt builders: analyzer.ts, notes.ts, publisher.ts

### Tests

- 81 new tests across 5 test files

## [1.0.2] — 2026-03-28

### Fixes

- Fix context-mode start.mjs path — after git clone, start.mjs lives at the repo root, not inside node_modules/context-mode/

## [1.0.1] — 2026-03-28

### Features

- Interactive tool selection — installer presents multiselect for optional dependencies
- Context-mode installed as platform extension via git clone → npm install → npm run build
- Dependency registry updated — context-mode detection checks for start.mjs in extension directory

## [1.0.0] — 2026-03-28

### Highlights

- Dual-platform abstraction — Pi + OMP adapters with runtime detection
- MCP server management — full /supi:mcp command with registry, TUI, session lifecycle, gateway tools
- /supi:doctor — infrastructure, integration, and platform capability checks
- Dependency registry — unified scan/install/report flow
- Installer rewrite — TypeScript with dual-platform detection
- /supi:update TUI — interactive dependency scan and install

### Breaking Changes

- All commands migrated from ExtensionAPI to Platform abstraction
- modelPreference replaced with role-based model configuration

### Fixes

- MCP: mcpc install, login flow, stdout+stderr capture, export type compatibility
- Platform migration type errors across dispatcher, hooks, config paths
- Restart prompt after update, sub-agent dispatch availability guard

## [0.7.8] — 2026-03-17

### Fixes

- Reverted FTS5 persistence hack — context-mode deletes its DB on process exit, making tmpdir patching ineffective

## [0.7.7] — 2026-03-17

### Features

- Persistent FTS5 index — context-mode's FTS5 database now lives in .omp/context-mode/ instead of /tmp/
- Indexed content carries forward across sessions via DB copy-on-start

## [0.7.6] — 2026-03-17

### Features

- Write .omp/SYSTEM.md with routing rules — MCP wrapper writes comprehensive context-mode routing rules loaded by OMP as system prompt

## [0.7.5] — 2026-03-17

### Fixes

- Fix context-mode MCP server working directory — added bin/ctx-mode-wrapper.mjs to capture real project directory

## [0.7.4] — 2026-03-17

### Fixes

- System prompt injection no longer depends on MCP detection timing — injects unconditionally when enforceRouting is enabled

## [0.7.3] — 2026-03-17

### Improvements

- Comprehensive SKILL.md routing rules replacing lightweight routing hints
- Fix stale cache in before_agent_start — re-detects every hook invocation

## [0.7.2] — 2026-03-17

### Fixes

- Fix OMP MCP tool detection — detector now matches single-underscore naming
- Auto-register context-mode MCP server from Claude Code plugin cache

## [0.7.1] — 2026-03-17

### Fixes

- Fix stale cache — re-detects MCP tools on every tool_call
- Route Find/Glob tool — OMP's Glob tool registered as "find" was not blocked
- Route Fetch/WebFetch tool — OMP's WebFetch tool registered as "fetch" was not blocked
- Add --skip-lsp flag for fully autonomous updates

## [0.7.0] — 2026-03-17

### Features

- Enforce context-mode tool routing — native search tools hard-blocked when context-mode equivalents available
- Read with limit/offset still allowed (edit prerequisite)
- Bash allowlist preserves git, npm, ls, mkdir, etc.
- New config: contextMode.enforceRouting (default: true)
- Routing logic extracted to src/context-mode/routing.ts with 35 tests

## [0.6.1] — 2026-03-17

### Fixes

- Context-mode detector now matches MCP-namespaced tool names — detection was doing exact lookups against bare names, always failing silently
