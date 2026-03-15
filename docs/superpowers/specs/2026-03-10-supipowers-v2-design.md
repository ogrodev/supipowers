# Supipowers v2 — Design Spec

## Overview

Supipowers v2 is an OMP-native extension that brings supipowers-style agentic workflows to the oh-my-pi coding agent. It replaces supipowers v1 with a ground-up rewrite focused on flexibility, opt-in workflows, and full leverage of OMP's infrastructure (sub-agents, LSP, MCP, plugin system).

## Core Principles

- **Action-driven**: Every command does something immediately. No state machine, no phase transitions. `/supi:plan` means start planning now.
- **Opt-in everything**: Quality gates, QA, release — all invocable when the user wants them, at the depth they choose. Nothing is enforced.
- **OMP-native**: Built exclusively for oh-my-pi. No vanilla pi fallback. Full use of sub-agents, LSP, MCP, and git tools.
- **Configurable**: Layered config (global + project) with named profiles for quality depth presets.

## Target Compatibility

OMP only (`@oh-my-pi/pi-coding-agent`). No degraded mode for vanilla pi.

## Commands

All commands use the `/supi:` namespace and are immediate actions, not state transitions.

### /supi

Overview command. Shows available commands and current project status (active runs, last review, config summary).

### /supi:plan

Starts collaborative planning immediately. Asks clarifying questions, proposes approaches, refines with the user, and produces a task breakdown. Each task is marked as parallel-safe or sequential, with description, target files, acceptance criteria, and estimated complexity. Supports `--quick "description"` to skip brainstorming for simple tasks. Plans are saved to `.omp/supipowers/plans/`.

### /supi:run

Executes a plan with sub-agent orchestration. The orchestration loop:

1. Load plan and resolve active profile
2. Identify next batch of parallel-safe tasks
3. Dispatch sub-agents (up to `maxParallelAgents` from config)
4. Collect results, send rich inline notifications
5. Review batch — resolve conflicts if any
6. If failures, dispatch fix agents
7. Repeat until all tasks complete
8. Final summary notification

Sub-agents have full OMP tool access including LSP, can spawn nested sub-agents, and report status as DONE, DONE_WITH_CONCERNS, or BLOCKED. Resumable: if interrupted, re-running reads the run manifest and picks up from the next incomplete batch.

### /supi:review

Triggers quality gates at the chosen depth. Uses the active profile by default, overridable with `--quick`, `--thorough`, or `--profile <name>`. Three built-in tiers:

- **Quick**: LSP diagnostics + AI quick scan (~30s)
- **Thorough**: LSP diagnostics + deep AI code review + code quality analysis (~2-3min)
- **Full regression**: All of the above + test suite execution + E2E/QA pipeline (~5-15min)

If no LSP is active, notifies the user and offers setup guidance. Review continues without LSP (graceful degradation).

### /supi:qa

Standalone QA pipeline. Detects test framework on first run and caches the result in config — subsequent runs read from config, no re-detection. Supports scoping: `/supi:qa` (all), `/supi:qa --changed` (changed files only), `/supi:qa --e2e` (Playwright only).

### /supi:release

Release automation. Analyzes commits since last tag, suggests version bump, generates release notes, tags and publishes (with user confirmation). First-time setup asks about the release process (npm publish, GitHub release, changelog file) and saves to config.

### /supi:config

View and edit configuration and profiles. Includes LSP setup guidance.

### /supi:status

Check on running sub-agents and task progress for active runs.

## Configuration

### Layered Config

- **Global**: `~/.omp/supipowers/config.json`
- **Project**: `.omp/supipowers/config.json` (overrides global)

### Config Shape

```json
{
  "defaultProfile": "thorough",
  "orchestration": {
    "maxParallelAgents": 3,
    "modelPreference": "auto"
  },
  "lsp": {
    "autoDetect": true,
    "setupGuide": true
  },
  "notifications": {
    "verbosity": "normal"
  },
  "qa": {
    "framework": null,
    "command": null
  },
  "release": {
    "pipeline": null
  }
}
```

The `qa.framework` and `qa.command` fields are auto-detected on first use and cached. `release.pipeline` is configured on first `/supi:release` invocation.

### Profiles

Named presets stored in `.omp/supipowers/profiles/`. Three built-in:

- **quick.json**: AI quick scan, LSP diagnostics, no QA
- **thorough.json**: Deep AI review, LSP diagnostics, code quality analysis
- **full-regression.json**: All gates + test suite + E2E/QA

Users can create custom profiles.

## Persistence

All artifacts stored in `.omp/supipowers/`:

```
.omp/supipowers/
  config.json
  profiles/
    quick.json
    thorough.json
    full-regression.json
  plans/
    <date>-<name>.md
  runs/
    <run-id>/
      manifest.json       ← plan ref, config, overall status
      agents/
        task-1.json        ← per-agent result + output
        task-2.json
  reports/
    review-<date>.json
    qa-<date>/
```

No workflow state files. No event logs. The run manifest and agent result files provide enough to resume interrupted runs.

## Sub-Agent Orchestration

Based on supipowers' model but enhanced with OMP capabilities:

- **Parallel execution**: Tasks marked as parallel-safe run concurrently (up to config limit)
- **Full tool access**: Sub-agents get all OMP tools including LSP queries
- **Nested sub-agents**: Sub-agents can spawn their own sub-agents when needed
- **Git-aware**: Sub-agents use OMP git tools for clean diffs
- **Simple coordination**: Orchestrator dispatches → collects results → reviews → dispatches fixes. No mid-run blackboard — the orchestrator has full context to resolve conflicts after each batch.
- **Three statuses**: DONE (clean), DONE_WITH_CONCERNS (completed with caveats), BLOCKED (needs intervention)

## LSP Integration

Leverages OMP's built-in LSP support (40+ languages):

- **Detection**: Check for active LSP on relevant operations
- **Setup guidance**: If no LSP found, help user configure one via `/supi:config`
- **Quality gate integration**: LSP diagnostics feed into `/supi:review`
- **Sub-agent intelligence**: Sub-agents query LSP before making changes (find references, check diagnostics after edits)
- **Graceful degradation**: Everything works without LSP, just better with it

## Notifications

Rich inline notification blocks using OMP's TUI. Styled text with colored borders and icons:

- **Success** (green): Task completed, review passed
- **Warning** (amber): Done with concerns, non-critical issues
- **Error** (red): Task blocked, gate failed
- **Info** (blue): Review results, status updates
- **Summary** (purple): Run complete, final stats

No persistent dashboard or widgets. Notifications appear inline as events happen.

## Skills

Targeted prompt templates loaded by TypeScript code when needed:

- **planning/SKILL.md**: Guides brainstorm and plan generation
- **code-review/SKILL.md**: Deep review methodology
- **debugging/SKILL.md**: Systematic debugging approach
- **qa-strategy/SKILL.md**: QA test planning

Skills are not a workflow framework. The user never has to "go through" them — they're tools the extension invokes internally to produce better results.

## Source Code Structure

```
src/
  index.ts                    ← extension entry point
  commands/                   ← slash command handlers (thin wiring)
    supi.ts, plan.ts, run.ts, review.ts, qa.ts, release.ts, config.ts, status.ts
  orchestrator/               ← sub-agent dispatch & coordination
    dispatcher.ts, batch-scheduler.ts, result-collector.ts, conflict-resolver.ts, prompts.ts
  quality/                    ← composable quality gates
    gate-runner.ts, lsp-gate.ts, ai-review-gate.ts, test-gate.ts
  qa/                         ← QA pipeline
    detector.ts, runner.ts, playwright.ts, report.ts
  lsp/                        ← LSP integration layer
    detector.ts, bridge.ts, setup-guide.ts
  notifications/              ← rich inline notifications
    renderer.ts, types.ts
  config/                     ← configuration & profiles
    loader.ts, profiles.ts, defaults.ts, schema.ts
  storage/                    ← persistence layer
    plans.ts, runs.ts, reports.ts
  release/                    ← release automation
    analyzer.ts, notes.ts, publisher.ts
  types.ts                    ← shared type definitions
skills/
  planning/SKILL.md
  code-review/SKILL.md
  debugging/SKILL.md
  qa-strategy/SKILL.md
tests/
  orchestrator/, quality/, config/, notifications/, lsp/
```

## Dependencies

- `@oh-my-pi/pi-coding-agent` (peer)
- `@oh-my-pi/pi-tui` (peer)
- `@sinclair/typebox` (peer, for config schema validation)
- `typescript` (dev)
- `vitest` (dev)

## Plan Format

Plans are structured markdown files with YAML frontmatter:

```markdown
---
name: auth-refactor
created: 2026-03-10
tags: [auth, api]
---

# Auth Refactor

## Context

Brief description of what this plan accomplishes.

## Tasks

### 1. Extract auth middleware [parallel-safe]

- **files**: src/middleware/auth.ts, src/middleware/index.ts
- **criteria**: Auth logic extracted into standalone middleware, existing tests pass
- **complexity**: small

### 2. Add JWT validation [sequential: depends on 1]

- **files**: src/middleware/auth.ts, src/utils/jwt.ts
- **criteria**: JWT tokens validated on protected routes, unit tests added
- **complexity**: medium
```

Each task has:

- **Name** with parallel annotation: `[parallel-safe]` or `[sequential: depends on N]`
- **files**: Target files the agent will work on
- **criteria**: Acceptance criteria the orchestrator checks against
- **complexity**: `small` | `medium` | `large` (informs model selection and timeout)

## Run Manifest Schema

```json
{
  "id": "run-20260310-143052",
  "planRef": "2026-03-10-auth-refactor.md",
  "profile": "thorough",
  "status": "running",
  "startedAt": "2026-03-10T14:30:52Z",
  "batches": [
    {
      "index": 0,
      "taskIds": [1, 3],
      "status": "completed"
    },
    {
      "index": 1,
      "taskIds": [2],
      "status": "pending"
    }
  ]
}
```

Run statuses: `running` | `completed` | `paused` | `failed`. Batch statuses: `pending` | `running` | `completed` | `failed`. On resume, the orchestrator finds the first non-completed batch and continues from there.

## Profile Schema

```json
{
  "name": "thorough",
  "gates": {
    "lspDiagnostics": true,
    "aiReview": { "enabled": true, "depth": "deep" },
    "codeQuality": true,
    "testSuite": false,
    "e2e": false
  },
  "orchestration": {
    "reviewAfterEachBatch": true,
    "finalReview": true
  }
}
```

Gate keys map 1:1 to gate implementations. Custom profiles can enable/disable any gate and configure gate-specific options.

## Conflict Resolution

When parallel sub-agents in a batch edit overlapping files:

1. **Detection**: After a batch completes, diff each agent's changed files against others in the same batch. Overlapping file paths trigger conflict detection.
2. **Auto-resolve**: If edits touch different regions of the same file (non-overlapping hunks), merge automatically.
3. **Dispatch merge agent**: If edits overlap, dispatch a dedicated merge agent with both versions and the original, plus the task context for each. The merge agent produces a unified result.
4. **User escalation**: If the merge agent reports BLOCKED, pause the run and notify the user with the conflicting diffs.

## Fix Agent Behavior

When a sub-agent reports failure or DONE_WITH_CONCERNS:

- **Input**: Original task brief + agent output + failure details
- **Max retries**: Configurable via `orchestration.maxFixRetries` (default: 2)
- **Escalation**: After max retries exhausted, the task is marked `failed` and the user is notified. The run continues with remaining tasks unless the failed task blocks downstream sequential tasks.
- **BLOCKED handling**: When a sub-agent reports BLOCKED, the run pauses that task immediately (no retry). The user is notified with the blocker details. The run continues with non-dependent tasks. On resume (`/supi:run`), the user can provide guidance or skip the blocked task.

## Parallel Agent Isolation

Sub-agents in a parallel batch work on the same worktree (no branch isolation). The batch scheduler ensures parallel-safe tasks target non-overlapping files. If the plan marks tasks as parallel-safe but they happen to touch the same file, the conflict resolver handles it post-batch. This keeps the model simple — no worktree-per-agent overhead — while the conflict resolver handles the rare edge case.

## Nested Sub-Agent Limits

Sub-agents can spawn nested sub-agents up to a configurable depth. Default: `orchestration.maxNestingDepth: 2`. At the limit, the agent works without sub-agents. This prevents runaway resource consumption.

## Configuration Details

### Merge Strategy

Project config deep-merges over global config. Per-key override at every nesting level: if a project config sets `orchestration.maxParallelAgents` but omits `orchestration.modelPreference`, `modelPreference` is inherited from global config.

### Model Preference

`orchestration.modelPreference` values:

- `"auto"`: Extension selects model based on task complexity — small tasks use cheaper/faster models, large tasks use more capable ones
- `"fast"`: Always use the fastest available model
- `"capable"`: Always use the most capable available model
- `"<model-id>"`: Use a specific model ID

### Config Versioning

Config files include a `version` field (semver). On load, if the version is older than current, the loader migrates forward automatically and writes the updated config. Breaking changes bump the major version.

```json
{
  "version": "1.0.0",
  "defaultProfile": "thorough",
  ...
}
```

## Git & .gitignore Guidance

Recommended `.gitignore` entries:

```
# Supipowers - ignore machine-specific artifacts
.omp/supipowers/runs/
.omp/supipowers/reports/
```

Plans and config/profiles should be committed — they're shareable project artifacts. Run results and reports are ephemeral and machine-specific.

## What Changed from v1

| v1                                                  | v2                                             |
| --------------------------------------------------- | ---------------------------------------------- |
| Rigid phase state machine                           | Action-driven commands                         |
| Enforced workflow                                   | Opt-in everything                              |
| Custom adapter routing (ant-colony/subagent/native) | Direct OMP sub-agent API                       |
| Vanilla pi with OMP as nice-to-have                 | OMP-only                                       |
| Persistent workflow state                           | Artifact persistence only                      |
| Status widget + view modes                          | Rich inline notifications                      |
| Quality gates as mandatory checkpoints              | Quality gates as invocable tools with profiles |
| QA baked into workflow                              | QA as standalone command                       |
