<img width="1584" height="672" alt="supipowers" src="https://github.com/user-attachments/assets/ec0f3658-54d7-4471-91ba-39297191f055" />

<div align="center">

[![npm version](https://img.shields.io/npm/v/supipowers.svg)](https://www.npmjs.com/package/supipowers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Workflow extension for OMP coding agents.**

Plan, execute, review, test, and ship — without leaving your agent session.

</div>

---

Supipowers adds agentic workflow commands on top of [Oh My Pi](https://github.com/can1357/oh-my-pi). It steers the active AI session using OMP's native extension API — no subprocess, no context switching.

## Installation

Run the interactive installer:

```bash
bunx supipowers
```

The installer detects your agent, registers the extension, and optionally sets up LSP servers, MCP tools, and the context-mode integration.

> [!TIP]
> Run `/supi:update` at any time to upgrade to the latest version, or `/supi:doctor` to check your setup.

### Requirements

| Dependency                                            | What it's for                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) | The coding agent that supipowers extends                              |
| [Bun](https://bun.sh)                                 | Runtime — required for installation and the built-in SQLite FTS index |
| [Git](https://git-scm.com)                            | Used by the installer and context-mode setup                          |

### Optional dependencies

The installer scans for these and offers to install any that are missing. Everything works without them, but each one unlocks additional capabilities.

| Dependency                            | What it enables                                                       |
| ------------------------------------- | --------------------------------------------------------------------- |
| [mcpc](https://github.com/apify/mcpc) | MCP server management via `/supi:mcp`                                 |
| supi-context-mode                     | Context window protection — large outputs are sandboxed automatically |
| `typescript-language-server`          | TypeScript/JS diagnostics and references in review gates              |
| `pyright`                             | Python type checking                                                  |
| `rust-analyzer`                       | Rust language server                                                  |
| `gopls`                               | Go language server                                                    |
| `@playwright/cli`                     | Browser exploration and E2E test execution via `/supi:qa`             |

> [!NOTE]
> LSP servers are language-specific — install only the ones that match your project's stack.
> supi-context-mode is heavily inspired at [context-mode](https://github.com/mksglu/context-mode)

## Commands

| Command                  | What it does                                                  |
| ------------------------ | ------------------------------------------------------------- |
| `/supi`                  | Interactive menu with commands and project status             |
| `/supi:plan`             | Collaborative planning with structured task breakdown         |
| `/supi:review`           | AI code review pipeline (quick, deep, multi-agent)            |
| `/supi:checks`           | Run deterministic quality gates                               |
| `/supi:qa`               | E2E testing pipeline with Playwright                          |
| `/supi:fix-pr`           | Assess and fix PR review comments                             |
| `/supi:release`          | Version bump, release notes, publish                          |
| `/supi:commit`           | AI-powered commit with conventional message generation        |
| `/supi:model`            | Configure model assignments per action (plan, review, qa…)    |
| `/supi:context`          | Show current context window usage and system prompt breakdown |
| `/supi:optimize-context` | Analyze loaded prompt/context usage and suggest reductions    |
| `/supi:mcp`              | Manage MCP servers (connect, disconnect, migrate)             |
| `/supi:config`           | Interactive settings TUI                                      |
| `/supi:status`           | Check running sub-agents and progress                         |
| `/supi:doctor`           | Diagnose extension health and missing dependencies            |
| `/supi:generate`        | Documentation drift detection                                |
| `/supi:update`           | Update supipowers to the latest version                       |

Most commands steer the AI session. These are TUI-only — they open native dialogs without triggering the AI: `/supi`, `/supi:config`, `/supi:status`, `/supi:update`, `/supi:doctor`, `/supi:mcp`, `/supi:model`, `/supi:context`, `/supi:optimize-context`, `/supi:commit`. `/supi:release` is mostly TUI-driven but can invoke AI for doc-drift fixes and polish mode.

## How it works

**Planning.** `/supi:plan` steers the AI through planning phases (scope → decompose → estimate → verify), saves the result to `.omp/supipowers/plans/`, and presents an approval UI. On approval, tasks execute in the same session.

**Quality gates.** `/supi:checks` runs deterministic quality gates. Six gates are available: `lsp-diagnostics`, `lint`, `typecheck`, `format`, `test-suite`, and `build`. Each gate can be enabled independently via `/supi:config` or `.omp/supipowers/config.json`. Gates report issues with severity levels.

**AI code review.** `/supi:review` runs a programmatic AI review pipeline with configurable depth (quick, deep, or multi-agent). It uses headless agent sessions with structured JSON validation, optional finding validation against actual code, and auto-fix support.

**PR fixing.** `/supi:fix-pr` fetches PR review comments, critically assesses each one, checks for ripple effects, then fixes or rejects with evidence. Bot reviewers are auto-detected and filtered out.

**Context protection.** When [context-mode](https://github.com/mksglu/context-mode) is detected, supipowers injects routing hooks that protect the agent's context window. Large outputs, file reads, and HTTP calls are automatically routed through sandboxed execution so only summaries enter the conversation.

**Model assignment.** Each action can be assigned a different model and thinking level. `/supi:model` opens a TUI picker backed by OMP's model registry.

## Feature comparison with `obra/superpowers`

> [!NOTE]
> Based on the current `supipowers` repo and the documented features in [`obra/superpowers`](https://github.com/obra/superpowers). ✅ = part of the current documented product surface. ❌ = not part of the current documented product surface.

| What is being compared                | supipowers | obra/superpowers |
| ------------------------------------- | ---------- | ---------------- |
| OMP-native slash commands             | ✅         | ❌               |
| Automatic skill activation            | ❌         | ✅               |
| Plan approval UI                      | ✅         | ❌               |
| Parallel agent execution workflow     | ✅         | ✅               |
| Code review workflow                  | ✅         | ✅               |
| TDD / debugging / verification skills | ✅         | ✅               |
| Browser QA / Playwright workflow      | ✅         | ❌               |
| PR review comment fixing workflow     | ✅         | ❌               |
| Release automation                    | ✅         | ❌               |
| Commit workflow                       | ✅         | ❌               |
| Context-window optimizations          | ✅         | ❌               |
| MCP server management through mcpc    | ✅         | ❌               |
| Git worktree workflow                 | ❌         | ✅               |

## Quality gates

`/supi:checks` runs deterministic quality gates. Each gate is independently configurable in `quality.gates` via `/supi:config` or the config JSON files:

| Gate               | What it checks                  | Config type       |
| ------------------ | ------------------------------- | ----------------- |
| `lsp-diagnostics`  | Language server diagnostics     | enabled           |
| `lint`             | Linter (e.g. `eslint`, `biome`) | enabled + command |
| `typecheck`        | Type checker (e.g. `tsc`)       | enabled + command |
| `format`           | Formatter check                 | enabled + command |
| `test-suite`       | Test runner                     | enabled + command |
| `build`            | Build verification              | enabled + command |

Gates default to disabled. Enable them per-project in `.omp/supipowers/config.json` or globally in `~/.omp/supipowers/config.json`.

## Configuration

```
/supi:config
```

Opens an interactive settings screen. Toggles flip instantly, selects open a picker, text fields open an input dialog.

Configuration is a three-layer deep-merge (lowest to highest priority):

1. Built-in defaults
2. `~/.omp/supipowers/config.json` — global overrides
3. `.omp/supipowers/config.json` — per-project overrides

## Skills

Supipowers ships runtime-loaded prompt skills that are also available to the agent during regular sessions:

| Skill                   | Used by                 |
| ----------------------- | ----------------------- |
| `planning`              | `/supi:plan`            |
| `code-review`           | `/supi:review`          |
| `qa-strategy`           | `/supi:qa`              |
| `fix-pr`                | `/supi:fix-pr`          |
| `debugging`             | Agent sessions          |
| `tdd`                   | Agent sessions          |
| `verification`          | Agent sessions          |
| `receiving-code-review` | Agent sessions          |
| `release`               | `/supi:release`         |
| `context-mode`          | Context window guidance |

## Development

```bash
bun install          # install dependencies
bun test             # run tests
bun run typecheck    # type-check without emitting
bun run build        # emit to dist/
```

Tests live in `tests/`, mirroring `src/` one-to-one. The test runner is Bun's built-in `bun:test`.
