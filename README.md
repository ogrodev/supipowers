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

The installer detects Pi (`~/.pi`) and OMP (`~/.omp`) — when both are present it offers a multiselect to install to one or both. It registers the extension, removes legacy external context-mode MCP registrations from `agent/mcp.json` and cleans up the old `settings/mcp.json` if present, and can install missing optional tooling such as LSP servers and Playwright CLI.

> [!TIP]
> Run `/supi:update` at any time to upgrade to the latest version, or `/supi:doctor` to check your setup.

### Requirements

| Dependency                                            | What it's for                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) | The coding agent that supipowers extends                              |
| [Bun](https://bun.sh)                                 | Runtime — required for installation and the built-in SQLite FTS index |
| [Git](https://git-scm.com)                            | Used by the installer and git-based workflows                         |

> [!TIP]
> OMP ≥15.1.7 is recommended for best reliability with supipowers command-driven agent handoffs and accurate provider-scoped `/fast` status indicators. Older compatible OMP versions can run supipowers but lack those runtime fixes.

### Optional dependencies

The installer scans for these and offers to install missing tooling where it can. Everything works without them, but each one unlocks additional capabilities.

| Dependency                            | What it enables                                                       |
| ------------------------------------- | --------------------------------------------------------------------- |
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
| `/supi:ui-design`        | Design Director pipeline — gather UI context, decompose target into components, build mockups in browser companion, validate, save to `.omp/supipowers/ui-design/` |
| `/supi:review`           | AI code review with validated findings docs and fix/document/discuss actions |
| `/supi:checks`           | Run deterministic quality gates                               |
| `/supi:qa`               | E2E testing pipeline with Playwright                          |
| `/supi:fix-pr`           | Assess and fix PR review comments                             |
| `/supi:release`          | Version bump, release notes, publish                          |
| `/supi:commit`           | AI-powered commit with conventional message generation        |
| `/supi:model`            | Configure model assignments per action (plan, review, qa…)    |
| `/supi:context`          | Show current context window usage and system prompt breakdown |
| `/supi:optimize-context` | Analyze loaded prompt/context usage and suggest reductions    |
| `/supi:config`           | Interactive settings TUI                                      |
| `/supi:status`           | Show project plans and configuration summary                  |
| `/supi:doctor`           | Diagnose extension health and missing dependencies            |
| `/supi:generate`        | Documentation drift checks via `docs` (default); use `--target <package>` to scope |
| `/supi:update`           | Update supipowers to the latest version                       |
| `/supi:agents`           | Manage review agents                                          |
| `/supi:ultraplan`        | Multi-stage authoring pipeline (intake → scout → discover → research → synthesize → review → approve) |
| `/supi:harness`          | Harness engineering pipeline and anti-slop guardrails         |
| `/supi:memory`           | Manage native MemPalace memory integration (`status`, `setup`) |
| `/runbook`              | Show registered OMP rules, TTSR conditions, and slash commands without an LLM turn |
| `/supi:clear`            | Clear metrics, cache, session knowledge, and memory           |

Most commands steer the AI session. These are TUI-only — they open native dialogs without triggering the AI: `/supi`, `/supi:config`, `/supi:status`, `/supi:review`, `/supi:update`, `/supi:doctor`, `/supi:model`, `/supi:context`, `/supi:optimize-context`, `/supi:commit`, `/supi:release`, `/supi:checks`, `/supi:agents`, `/supi:ultraplan`, `/supi:harness`, `/supi:memory`, `/supi:clear`, `/runbook`.

## How it works

**Planning.** `/supi:plan` steers the AI through planning phases (Explore → Clarify → Brainstorm → Design & Save → Review Loop → User Gate → Plan), saves the result to `.omp/supipowers/plans/`, and presents an approval UI. On approval, tasks execute in the same session.

**Quality gates.** `/supi:checks` runs deterministic quality gates. Six gates are available: `lsp-diagnostics`, `lint`, `typecheck`, `format`, `test-suite`, and `build`. Each gate can be enabled independently via `/supi:config` or the shared repository config at `.omp/supipowers/config.json`. In monorepos, `/supi:checks` defaults to `All`, which runs the root target plus every workspace target sequentially; use `--target <package>` to narrow the run or `--target all` to request the batch mode explicitly. Gates report issues with severity levels.

**Documentation drift.** `/supi:generate docs` checks tracked documentation for drift from the current codebase. `docs` is the default subcommand, and `--target <package>` scopes discovery and checking to a workspace/package target; the root target covers repository-level docs.

**AI code review.** `/supi:review` runs a programmatic AI review pipeline with configurable depth (quick, deep, or multi-agent). It uses headless agent sessions with structured JSON validation, always validates findings before user action, writes the current validated findings to a session `findings.md` document, and then presents three next-step choices: `Fix now`, `Document only`, or `Discuss before fixing`.

**Review agents.** Multi-agent review loads agents from two scopes: global and project.

- Global defaults and global custom agents live under `~/.omp/supipowers/review-agents/`.
- Project configuration lives under `.omp/supipowers/review-agents/config.yml`.
- Default built-in agent markdown files are installed globally, not per-project.
- Project custom agent markdown files can still live under `.omp/supipowers/review-agents/`.
- Merge precedence is project over global: if the project config mentions an agent name, it shadows the global agent with the same name.
- A project entry with `enabled: false` suppresses the global agent with that same name instead of falling back to the global copy.

Use `/supi:agents` to inspect the merged set that will actually run.

**PR fixing.** `/supi:fix-pr` fetches PR review comments, critically assesses each one, checks for ripple effects, then fixes or rejects with evidence. Known bot reviewers in the selected comment snapshot are auto-detected to configure re-review triggering; bot-authored comments are not filtered out solely because they are bots.

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
| Git worktree workflow                 | ❌         | ✅               |

## Quality gates

`/supi:checks` runs deterministic quality gates. Each gate is independently configurable in `quality.gates` via `/supi:config` or the shared config JSON files:

| Gate               | What it checks                  | Config type                    |
| ------------------ | ------------------------------- | ------------------------------ |
| `lsp-diagnostics`  | Language server diagnostics     | `enabled`                      |
| `lint`             | Linter (e.g. `eslint`, `biome`) | `enabled: true` + `runs[]`     |
| `typecheck`        | Type checker (e.g. `tsc`)       | `enabled: true` + `runs[]`     |
| `format`           | Formatter check                 | `enabled: true` + `runs[]`     |
| `test-suite`       | Test runner                     | `enabled: true` + `runs[]`     |
| `build`            | Build verification              | `enabled: true` + `runs[]`     |

Gates default to disabled. Enable them globally in `~/.omp/supipowers/config.json` or per-repository in `.omp/supipowers/config.json`. In monorepos, the repository config is shared by the root target and every workspace, and `/supi:checks` defaults to `All` (root target + every workspace target).

Enabled command gates require `runs: [{ command, target }]`. `target.scope` must be one of `all-targets`, `root`, `all-workspaces`, or `workspace`; `workspace` selectors also require `relativeDir`.

```json
{
  "quality": {
    "gates": {
      "typecheck": {
        "enabled": true,
        "runs": [
          {
            "command": "bun run typecheck",
            "target": { "scope": "all-targets" }
          }
        ]
      },
      "test-suite": {
        "enabled": true,
        "runs": [
          {
            "command": "bun test",
            "target": { "scope": "root" }
          },
          {
            "command": "bun --cwd packages/api test",
            "target": { "scope": "workspace", "relativeDir": "packages/api" }
          }
        ]
      }
    }
  }
}
```

## Configuration

```
/supi:config
```

Opens an interactive settings screen. Toggles flip instantly, selects open a picker, text fields open an input dialog.

Configuration uses built-in defaults plus two user-managed override layers:

1. Built-in defaults
2. `~/.omp/supipowers/config.json` — global overrides
3. `.omp/supipowers/config.json` — repository overrides

`/supi:config` exposes only `Global` and `Repository`. In monorepos, the repository config is shared across every workspace; there are no per-workspace Supipowers config files for general settings.

MemPalace hook timeouts are configured under `mempalace.timeouts`. Keep `hookMs` at or above `6000` when `mempalace.hooks.autoSearchOnPrompt` is enabled; MemPalace search can now pause before retrying a transient index lookup. The built-in default is `10000`.

## Release channels

Three built-in channels are available: `github` (GitHub Release via `gh` CLI), `gitlab` (GitLab Release via `glab` CLI), and `gitea` (Gitea Release via `tea` CLI). Channels are selected per-project in `release.channels`.

`/supi:release` auto-detects publishable release targets at runtime. In single-package repos it keeps the classic root-package flow. In Bun, npm, pnpm, and Yarn workspaces it discovers publishable packages from workspace metadata, auto-selects the only publishable target when there is one, and otherwise opens a picker that lists all publishable packages with changed packages first. Target choice is runtime-only and is not persisted to config.

Release notes are scoped to the selected target's publishable paths. When that target declares a `files` whitelist in its `package.json`, only commits touching those paths are included. Otherwise the changelog falls back to the target package directory plus its `package.json`. Root releases keep the configured `release.tagFormat`; workspace releases use `<package-name>@<version>` tags to avoid collisions across packages.

`/supi:release` accepts three optional flags:

| Flag | Effect |
| ----------- | ------ |
| `--target <package>` | Skip the target picker and release the named package directly |
| `--raw` | Skip AI polish of release notes; use raw conventional-commit output |
| `--dry-run` | Run the full release flow without publishing |

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
| `publishCommand` | yes      | Shell command run to publish; `$tag`, `$version`, `$changelog`, `$targetName`, `$targetId`, `$targetPath`, `$manifestPath`, and `$packageManager` are passed as environment variables |
| `detectCommand`  | no       | Shell command to detect availability; exit 0 = available. If omitted, the channel is assumed available |

## Skills

Supipowers ships runtime-loaded prompt skills that are also available to the agent during regular sessions:

| Skill                   | Used by                 |
| ----------------------- | ----------------------- |
| `planning`              | `/supi:plan`            |
| `ui-design`             | `/supi:ui-design`       |
| `code-review`           | Manual prompting / reusable review guidance |
| `qa-strategy`           | `/supi:qa`              |
| `fix-pr`                | `/supi:fix-pr`          |
| `debugging`             | Agent sessions          |
| `tdd`                   | Agent sessions          |
| `verification`          | Agent sessions          |
| `receiving-code-review` | Agent sessions          |
| `release`               | `/supi:release`         |
| `context-mode`          | Context window guidance |
| `ultraplan-intake`      | `/supi:ultraplan plan` intake stage |
| `ultraplan-scout`       | `/supi:ultraplan plan` scout stage |
| `ultraplan-discover`    | `/supi:ultraplan discover` |
| `ultraplan-research`    | `/supi:ultraplan research` |
| `ultraplan-synthesize`  | `/supi:ultraplan synthesize` |
| `ultraplan-review`      | `/supi:ultraplan review` orchestration |
| `ultraplan-review-structure` | `/supi:ultraplan review` structure checker |
| `ultraplan-review-scope` | `/supi:ultraplan review` scope checker |
| `ultraplan-review-tdd`  | `/supi:ultraplan review` TDD checker |
| `creating-supi-agents`  | Agent creation guidance  |
| `harness`               | `/supi:harness`         |

## Containerized deployments

Supipowers runs unchanged inside containerized OMP installs (robomp slots, the swarm extension, CI runners). When the slot must stay credential-free, run a sidecar `omp auth-gateway` outside the container and pin the per-provider transport in `~/.omp/agent/models.yml`:

```yaml
providers:
  anthropic:
    transport: pi-native
    baseUrl: http://llm-gateway.internal:4000
    apiKey: <gateway-bearer>
```

The slot keeps resolving pricing, capabilities, and thinking config locally from its bundled `models.json`; only the streaming dispatch is redirected through the gateway, which holds the real provider tokens. Multi-host credential sync uses the matching `omp auth-broker` subcommand. Requires OMP ≥ 15.1.3.

## Development

```bash
bun install          # install dependencies
bun test             # run tests
bun run typecheck    # type-check without emitting
bun run build        # emit to dist/
```

Tests live in `tests/`, mirroring `src/` one-to-one. The test runner is Bun's built-in `bun:test`.

Peer dependencies (`@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-tui`) are provided by the OMP host at runtime; matching devDependencies are installed for type-checking during development.
