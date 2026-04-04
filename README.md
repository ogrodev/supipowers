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

| Dependency | What it's for |
| --- | --- |
| [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) | The coding agent that supipowers extends |
| [Bun](https://bun.sh) | Runtime — required for installation and the built-in SQLite FTS index |
| [Git](https://git-scm.com) | Used by the installer and context-mode setup |

### Optional dependencies

The installer scans for these and offers to install any that are missing. Everything works without them, but each one unlocks additional capabilities.

| Dependency | What it enables |
| --- | --- |
| [mcpc](https://github.com/apify/mcpc) | MCP server management via `/supi:mcp` |
| [context-mode](https://github.com/ogrodev/context-mode) | Context window protection — large outputs are sandboxed automatically |
| `typescript-language-server` | TypeScript/JS diagnostics and references in review gates |
| `pyright` | Python type checking |
| `rust-analyzer` | Rust language server |
| `gopls` | Go language server |
| `@playwright/cli` | Browser exploration and E2E test execution via `/supi:qa` |

> [!NOTE]
> LSP servers are language-specific — install only the ones that match your project's stack.

## Commands

| Command | What it does |
| --- | --- |
| `/supi` | Interactive menu with commands and project status |
| `/supi:plan` | Collaborative planning with structured task breakdown |
| `/supi:review` | Run quality gates at chosen depth |
| `/supi:qa` | E2E testing pipeline with Playwright |
| `/supi:fix-pr` | Assess and fix PR review comments |
| `/supi:release` | Version bump, release notes, publish |
| `/supi:commit` | AI-powered commit with conventional message generation |
| `/supi:model` | Configure model assignments per action (plan, review, qa…) |
| `/supi:context` | Show current context window usage and system prompt breakdown |
| `/supi:mcp` | Manage MCP servers (connect, disconnect, migrate) |
| `/supi:config` | Interactive settings TUI |
| `/supi:status` | Check running sub-agents and progress |
| `/supi:doctor` | Diagnose extension health and missing dependencies |
| `/supi:update` | Update supipowers to the latest version |

Commands like `/supi`, `/supi:config`, `/supi:commit`, and `/supi:status` are TUI-only — they open native dialogs without triggering the AI session.

## How it works

**Planning.** `/supi:plan` steers the AI through planning phases (scope → decompose → estimate → verify), saves the result to `.omp/supipowers/plans/`, and presents an approval UI. On approval, tasks execute in the same session.

**Quality gates.** `/supi:review` runs composable checks selected by profile. LSP diagnostics surface real type errors. AI review catches logic issues. Test gates run your actual test suite. Each gate reports issues with severity levels.

**PR fixing.** `/supi:fix-pr` fetches PR review comments, critically assesses each one, checks for ripple effects, then fixes or rejects with evidence. Bot reviewers are auto-detected and filtered out.

**Context protection.** When [context-mode](https://github.com/ogrodev/context-mode) is detected, supipowers injects routing hooks that protect the agent's context window. Large outputs, file reads, and HTTP calls are automatically routed through sandboxed execution so only summaries enter the conversation.

**Model assignment.** Each action (planning, review, QA) can be assigned a different model and thinking level. `/supi:model` opens a TUI picker backed by OMP's model registry.

## Quality profiles

Three built-in profiles control how much `/supi:review` checks:

| Profile | LSP | AI Review | Code Quality | Tests | E2E |
| --- | --- | --- | --- | --- | --- |
| `quick` | ✓ | quick scan | — | — | — |
| `thorough` _(default)_ | ✓ | deep | ✓ | — | — |
| `full-regression` | ✓ | deep | ✓ | ✓ | ✓ |

Create custom profiles in `.omp/supipowers/profiles/`.

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

| Skill | Used by |
| --- | --- |
| `planning` | `/supi:plan` |
| `code-review` | `/supi:review` |
| `qa-strategy` | `/supi:qa` |
| `fix-pr` | `/supi:fix-pr` |
| `debugging` | Agent sessions |
| `tdd` | Agent sessions |
| `verification` | Agent sessions |
| `receiving-code-review` | Agent sessions |
| `context-mode` | Context window guidance |

## Development

```bash
bun install          # install dependencies
bun test             # run tests
bun run typecheck    # type-check without emitting
bun run build        # emit to dist/
```

Tests live in `tests/`, mirroring `src/` one-to-one. The test runner is Bun's built-in `bun:test`.
