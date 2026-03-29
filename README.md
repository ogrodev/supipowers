<img width="1584" height="672" alt="supipowers" src="https://github.com/user-attachments/assets/ec0f3658-54d7-4471-91ba-39297191f055" />

<div align="center">

# Supipowers

[![npm version](https://img.shields.io/npm/v/supipowers?style=flat-square)](https://www.npmjs.com/package/supipowers)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

Agentic workflows for [Pi](https://github.com/mariozechner/pi-coding-agent) and [OMP](https://github.com/can1357/oh-my-pi) coding agents.
Plan features, orchestrate sub-agents, run quality gates, fix PRs, manage MCP servers, and ship releases. All from slash commands.

[Install](#install) · [Commands](#commands) · [How it works](#how-it-works) · [Configuration](#configuration) · [Development](#development)

</div>

## Install

```bash
bunx supipowers@latest
```

The installer detects which agent you're running (Pi or OMP), copies supipowers into the right directory, and optionally sets up LSP servers for better code intelligence. Re-running the installer upgrades to the latest version if one is available.

### Update from inside your agent

```
/supi:update
```

Checks npm for the latest version, downloads and installs it. No prompts, no restart needed.

## Requirements

### Required

| Dependency | What it's for |
| --- | --- |
| [Pi](https://github.com/mariozechner/pi-coding-agent) or [OMP](https://github.com/can1357/oh-my-pi) | The coding agent that supipowers extends |
| [Bun](https://bun.sh) | Runtime (provides bun:sqlite with FTS5 for full-text search) |
| [Git](https://git-scm.com) | Version control (used by the installer and context-mode setup) |

### Optional

The installer scans for these and offers to install any that are missing. Everything works without them, but each one unlocks additional capabilities.

| Dependency | Category | What it enables | Install command |
| --- | --- | --- | --- |
| [mcpc](https://github.com/apify/mcpc) | MCP | MCP server management via `/supi:mcp` | `npm install -g @apify/mcpc` |
| [context-mode](https://github.com/mksglu/context-mode) | MCP | Context window protection (auto-routes large outputs through sandboxed execution) | Installed as extension via `git clone` + `npm install` |
| [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server) | LSP | TypeScript/JavaScript diagnostics, references, completions | `bun add -g typescript-language-server typescript` |
| [Pyright](https://github.com/microsoft/pyright) | LSP | Python type checking and language features | `pip install pyright` |
| [rust-analyzer](https://rust-analyzer.github.io) | LSP | Rust language server | `rustup component add rust-analyzer` |
| [gopls](https://pkg.go.dev/golang.org/x/tools/gopls) | LSP | Go language server | `go install golang.org/x/tools/gopls@latest` |
| [playwright-cli](https://github.com/microsoft/playwright-cli) | Testing | Browser automation for E2E testing via `/supi:qa --e2e` | `npm install -g @playwright/cli@latest` |

LSP servers are language-specific. You only need the ones matching the languages in your project. Sub-agents use them to check diagnostics and find references before making changes.

> [!TIP]
> Run `/supi:doctor` at any time to check which dependencies are installed and which are missing.

## Commands

| Command         | What it does                                          |
| --------------- | ----------------------------------------------------- |
| `/supi`         | Interactive menu with commands and project status     |
| `/supi:plan`    | Collaborative planning with structured task breakdown |
| `/supi:run`     | Execute a plan with parallel sub-agents               |
| `/supi:review`  | Quality gates at chosen depth                         |
| `/supi:qa`      | Run test suite and E2E pipeline                       |
| `/supi:release` | Version bump, release notes, publish                  |
| `/supi:fix-pr`  | Assess and fix PR review comments                     |
| `/supi:mcp`     | Manage MCP servers (connect, disconnect, list)        |
| `/supi:config`  | Interactive settings (TUI)                            |
| `/supi:status`  | Check running sub-agents and progress                 |
| `/supi:doctor`  | Diagnose extension health and configuration           |
| `/supi:update`  | Update supipowers to latest version                   |

Commands like `/supi`, `/supi:config`, `/supi:status`, and `/supi:update` open native TUI dialogs. They don't send chat messages or trigger the AI.

### Planning

```
/supi:plan add authentication to the API
```

Starts an interactive session: clarifying questions, approach proposals, then a structured task breakdown saved to `.omp/supipowers/plans/` (or the Pi equivalent).

For simple tasks, skip the brainstorming:

```
/supi:plan --quick add rate limiting middleware
```

### Running plans

```
/supi:run
```

Loads the latest plan and executes it with sub-agent orchestration. Tasks marked `[parallel-safe]` run concurrently (up to the configured limit). Sequential tasks respect their dependency chains.

The orchestration loop: dispatch batch, collect results, detect conflicts, retry failures, next batch. If interrupted, re-running picks up where it left off.

### Quality review

```
/supi:review           # opens profile picker
/supi:review --quick   # fast: LSP diagnostics + AI scan
/supi:review --thorough  # deep: full AI review + code quality
/supi:review --full    # everything: tests + E2E + all gates
```

When no flag is provided, a TUI picker lets you choose the review profile interactively.

### QA

```
/supi:qa              # opens scope picker
/supi:qa --changed    # tests for changed files only
/supi:qa --e2e        # Playwright / E2E only
```

Detects your test framework on first run (vitest, jest, pytest, cargo test, go test) and caches it. E2E mode (`--e2e`) uses `playwright-cli` to run browser tests autonomously. When no flag is provided, a TUI picker lets you choose the scope.

### Fix PR

```
/supi:fix-pr          # auto-detects current branch PR
/supi:fix-pr 42       # targets PR #42
```

Pulls review comments from GitHub, assesses each one (some comments deserve pushback, not code changes), then fixes what needs fixing. Tracks sessions so you can pick up where you left off.

### Release

```
/supi:release
```

Analyzes commits since last tag, suggests a version bump, generates release notes, and publishes. On first run, a TUI picker lets you choose your pipeline (npm, GitHub release, or manual).

### MCP servers

```
/supi:mcp
```

Register, connect, and manage MCP (Model Context Protocol) servers through supipowers. Each server gets auto-generated trigger rules so the agent knows when to use its tools without being told explicitly.

## How it works

Supipowers runs as an extension inside Pi or OMP. A platform abstraction layer handles the API differences between the two agents, so every command works the same regardless of which agent you're using.

**Sub-agent orchestration.** Plans are broken into batches of parallel-safe tasks. Each batch dispatches sub-agents with full tool access (file editing, bash, LSP). After a batch completes, the orchestrator checks for file conflicts, retries failures, and moves to the next batch.

**Quality gates.** Composable checks selected by profile. LSP diagnostics surface real type errors. AI review catches logic issues. Test gates run your actual test suite. Gates report issues with severity levels (error, warning, info).

**LSP integration.** Sub-agents query LSP before making changes (find references, check diagnostics). If no LSP is active, everything still works, just with less precision. The installer offers to set up LSP servers during installation.

**Context-mode integration.** When the [context-mode](https://github.com/ogrodev/context-mode) MCP server is detected, supipowers injects routing hooks that protect the agent's context window. Large command outputs, file reads, and HTTP calls are automatically routed through sandboxed execution so only summaries enter the conversation.

**Update checking.** On session start, supipowers checks npm for a newer version in the background. If one is available, a notification tells you to run `/supi:update`.

## Configuration

```
/supi:config
```

Opens an interactive settings screen. Select a setting to change its value: toggles flip instantly, selects open a picker, text fields open an input dialog.

### Profiles

Three built-in profiles control quality gate depth:

| Profile           | LSP | AI Review   | Code Quality | Tests | E2E |
| ----------------- | --- | ----------- | ------------ | ----- | --- |
| `quick`           | yes | quick scan  | no           | no    | no  |
| `thorough`        | yes | deep review | yes          | no    | no  |
| `full-regression` | yes | deep review | yes          | yes   | yes |

Create custom profiles in `.omp/supipowers/profiles/`.

### Key settings

```jsonc
{
  "defaultProfile": "thorough",
  "orchestration": {
    "maxParallelAgents": 3, // concurrent sub-agents per batch
    "maxFixRetries": 2, // retry failed tasks
    "maxNestingDepth": 2, // sub-agent nesting limit
    "modelPreference": "auto",
  },
  "lsp": {
    "setupGuide": true,
  },
  "qa": {
    "framework": null, // auto-detected and cached
    "command": null,
  },
}
```

Config lives in `~/.omp/agent/extensions/supipowers/` (OMP) or `~/.pi/agent/extensions/supipowers/` (Pi) and is managed entirely through `/supi:config`.

## Skills

Supipowers ships with prompt skills that commands load at runtime to steer AI sessions:

| Skill                   | Used by                                |
| ----------------------- | -------------------------------------- |
| `planning`              | `/supi:plan`                           |
| `code-review`           | `/supi:review`                         |
| `debugging`             | Failure retry loop                     |
| `qa-strategy`           | `/supi:qa`                             |
| `fix-pr`                | `/supi:fix-pr`                         |
| `tdd`                   | Plan tasks with test-first annotations |
| `verification`          | Pre-completion checks                  |
| `receiving-code-review` | Review comment assessment              |
| `context-mode`          | Context-mode routing hooks             |

Skills are markdown files in `skills/`. They're loaded on demand, not bundled at build time.

## Project structure

```
src/
  index.ts                     # extension entry + platform detection
  bootstrap.ts                 # command registration orchestrator
  platform/                    # dual-platform abstraction (Pi + OMP)
    detect.ts, types.ts, pi.ts, omp.ts
  commands/                    # one file per slash command
    supi.ts, plan.ts, run.ts, review.ts, qa.ts, release.ts,
    fix-pr.ts, mcp.ts, config.ts, status.ts, doctor.ts, update.ts
  orchestrator/                # sub-agent dispatch & coordination
    batch-scheduler.ts, dispatcher.ts, result-collector.ts,
    conflict-resolver.ts, prompts.ts
  planning/                    # plan writing & review prompts
    plan-writer-prompt.ts, plan-reviewer.ts,
    spec-reviewer.ts, prompt-builder.ts
  quality/                     # composable quality gates
    gate-runner.ts, lsp-gate.ts, ai-review-gate.ts, test-gate.ts
  qa/                          # QA pipeline
    session.ts, matrix.ts, prompt-builder.ts, config.ts
  fix-pr/                      # PR comment assessment & fixing
    prompt-builder.ts, config.ts, types.ts
  mcp/                         # MCP server gateway
    gateway.ts, registry.ts, activation.ts, triggers.ts,
    lifecycle.ts, manager-tool.ts, mcpc.ts, config.ts
  context-mode/                # context-mode integration
    hooks.ts, routing.ts, detector.ts, installer.ts,
    compressor.ts, event-store.ts, event-extractor.ts,
    snapshot-builder.ts
  lsp/                         # LSP integration
    detector.ts, bridge.ts, setup-guide.ts
  release/                     # release automation
    analyzer.ts, notes.ts, publisher.ts
  config/                      # configuration & profiles
    loader.ts, profiles.ts, defaults.ts, schema.ts
  storage/                     # persistence layer
    plans.ts, runs.ts, reports.ts, specs.ts,
    qa-sessions.ts, fix-pr-sessions.ts
  notifications/               # rich inline notifications
    renderer.ts, types.ts
  types.ts                     # shared type definitions
skills/                        # runtime-loaded prompt skills
bin/
  install.mjs                  # bunx installer
```

## Development

```bash
git clone https://github.com/ogrodev/supipowers.git
cd supipowers
bun install
bun test              # run all tests
bun run typecheck     # type checking
bun run test:watch    # watch mode
bun run build         # emit to dist/
```

The test suite mirrors the `src/` structure under `tests/`. Tests use Vitest with global imports and inline mocks (no module-level `vi.mock` calls). Filesystem tests use temp directories created in `beforeEach`.

> [!NOTE]
> Supipowers works with both Pi and OMP. The platform abstraction in `src/platform/` normalizes API differences (event names, tool registration, message delivery) so you can develop against either agent.


## License

MIT
