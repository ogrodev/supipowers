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

The installer detects your agent, registers the extension, removes legacy external context-mode MCP registrations, and can install missing optional tooling such as LSP servers, `mcpc`, and Playwright CLI.

> [!TIP]
> Run `/supi:update` at any time to upgrade to the latest version, or `/supi:doctor` to check your setup.

### Requirements

| Dependency                                            | What it's for                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) | The coding agent that supipowers extends                              |
| [Bun](https://bun.sh)                                 | Runtime — required for installation and the built-in SQLite FTS index |
| [Git](https://git-scm.com)                            | Used by the installer and git-based workflows                         |

### Optional dependencies

The installer scans for these and offers to install missing tooling where it can. Everything works without them, but each one unlocks additional capabilities.

| Dependency                            | What it enables                                                       |
| ------------------------------------- | --------------------------------------------------------------------- |
| [mcpc](https://github.com/apify/mcpc) | MCP server management via `/supi:mcp`                                 |
| `typescript-language-server`          | TypeScript/JS diagnostics and references in review gates              |
| `pyright`                             | Python type checking                                                  |
| `rust-analyzer`                       | Rust language server                                                  |
| `gopls`                               | Go language server                                                    |
| `@playwright/cli`                     | Browser exploration and E2E test execution via `/supi:qa`             |

> [!NOTE]
> LSP servers are language-specific — install only the ones that match your project's stack.
> Context protection is built into supipowers. No external `context-mode` or `supi-context-mode` dependency is required.
> The design is inspired by [context-mode](https://github.com/mksglu/context-mode).

## Commands

| Command                  | What it does                                                  |
| ------------------------ | ------------------------------------------------------------- |
| `/supi`                  | Interactive menu with commands and project status             |
| `/supi:plan`             | Collaborative planning with structured task breakdown         |
| `/supi:review`           | AI code review with validated findings docs and fix/document/discuss actions |
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
| `/supi:status`           | Show project plans and configuration summary                  |
| `/supi:doctor`           | Diagnose extension health and missing dependencies            |
| `/supi:generate`        | Documentation drift detection                                |
| `/supi:update`           | Update supipowers to the latest version                       |
| `/supi:agents`           | Manage review agents                                          |

Most commands steer the AI session. These are TUI-only — they open native dialogs without triggering the AI: `/supi`, `/supi:config`, `/supi:status`, `/supi:review`, `/supi:update`, `/supi:doctor`, `/supi:mcp`, `/supi:model`, `/supi:context`, `/supi:optimize-context`, `/supi:commit`, `/supi:release`, `/supi:checks`, `/supi:agents`.

## How it works

**Planning.** `/supi:plan` steers the AI through planning phases (scope → decompose → estimate → verify), saves the result to `.omp/supipowers/plans/`, and presents an approval UI. On approval, tasks execute in the same session.

**Quality gates.** `/supi:checks` runs deterministic quality gates. Six gates are available: `lsp-diagnostics`, `lint`, `typecheck`, `format`, `test-suite`, and `build`. Each gate can be enabled independently via `/supi:config` or `.omp/supipowers/config.json`. Gates report issues with severity levels.

**AI code review.** `/supi:review` runs a programmatic AI review pipeline with configurable depth (quick, deep, or multi-agent). It uses headless agent sessions with structured JSON validation, always validates findings before user action, writes the current validated findings to a session `findings.md` document, and then presents three next-step choices: `Fix now`, `Document only`, or `Discuss before fixing`.

**Review agents.** Multi-agent review loads agents from two scopes: global and project.

- Global defaults and global custom agents live under `~/.omp/supipowers/review-agents/`.
- Project configuration lives under `.omp/supipowers/review-agents/config.yml`.
- Default built-in agent markdown files are installed globally, not per-project.
- Project custom agent markdown files can still live under `.omp/supipowers/review-agents/`.
- Merge precedence is project over global: if the project config mentions an agent name, it shadows the global agent with the same name.
- A project entry with `enabled: false` suppresses the global agent with that same name instead of falling back to the global copy.

Use `/supi:agents` to inspect the merged set that will actually run.

**PR fixing.** `/supi:fix-pr` fetches PR review comments, critically assesses each one, checks for ripple effects, then fixes or rejects with evidence. Bot reviewers are auto-detected and filtered out.

**Context protection.** Supipowers always enables built-in context protection through native `ctx_*` tools and routing hooks. Search/find and web-fetch style operations are redirected to sandboxed execution or indexed storage, and oversized tool results are compressed before they reach the conversation.

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


## Release channels

Three built-in channels are available: `github` (GitHub Release via `gh` CLI), `gitlab` (GitLab Release via `glab` CLI), and `gitea` (Gitea Release via `tea` CLI). Channels are selected per-project in `release.channels`.

Custom channels can be defined in `release.customChannels`:

```json
{
  "release": {
    "customChannels": {
      "my-channel": {
        "label": "My Channel",
        "publishCommand": "./scripts/publish.sh $tag",
        "detectCommand": "which my-tool"
      }
    }
  }
}
```

| Field            | Required | Description                                                    |
| ---------------- | -------- | -------------------------------------------------------------- |
| `label`          | yes      | Display name shown in the release picker                       |
| `publishCommand` | yes      | Shell command run to publish; `$tag`, `$version`, `$changelog` are passed as environment variables |
| `detectCommand`  | no       | Shell command to detect availability; exit 0 = available. If omitted, the channel is assumed available |

## Skills

Supipowers ships runtime-loaded prompt skills that are also available to the agent during regular sessions:

| Skill                   | Used by                 |
| ----------------------- | ----------------------- |
| `planning`              | `/supi:plan`            |
| `code-review`           | Manual prompting / reusable review guidance |
| `qa-strategy`           | `/supi:qa`              |
| `fix-pr`                | `/supi:fix-pr`          |
| `debugging`             | Agent sessions          |
| `tdd`                   | Agent sessions          |
| `verification`          | Agent sessions          |
| `receiving-code-review` | Agent sessions          |
| `release`               | `/supi:release`         |
| `context-mode`          | Context window guidance |
| `creating-supi-agents`  | Agent creation guidance  |

## Development

```bash
bun install          # install dependencies
bun test             # run tests
bun run typecheck    # type-check without emitting
bun run build        # emit to dist/
```

Tests live in `tests/`, mirroring `src/` one-to-one. The test runner is Bun's built-in `bun:test`.

Peer dependencies (`@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-tui`, `@sinclair/typebox`) are provided by the OMP host; they are devDependencies only for type-checking during development.
