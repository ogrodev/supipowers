<img width="1584" height="672" alt="image" src="https://github.com/user-attachments/assets/fd446416-4573-488d-890c-6dbd4a13553f" />

# Supipowers

Agentic workflows for [OMP](https://github.com/can1357/oh-my-pi). Plan features, orchestrate sub-agents, run quality gates, and ship releases — all from slash commands.

## Install

```bash
bunx supipowers@latest
```

The installer checks for OMP, helps you install it if needed, sets up supipowers, and optionally configures LSP servers for your project.

### Manual install

```bash
# Global (all projects)
omp install npm:supipowers

# Project-local
omp install npm:supipowers -l
```

## Commands

| Command         | What it does                                     |
| --------------- | ------------------------------------------------ |
| `/supi`         | Overview — available commands and project status |
| `/supi:plan`    | Collaborative planning with task breakdown       |
| `/supi:run`     | Execute a plan with parallel sub-agents          |
| `/supi:review`  | Quality gates at chosen depth                    |
| `/supi:qa`      | Run test suite and E2E pipeline                  |
| `/supi:release` | Version bump, release notes, publish             |
| `/supi:config`  | View and edit configuration                      |
| `/supi:status`  | Check running sub-agents and progress            |

### Planning

```
/supi:plan add authentication to the API
```

Starts an interactive planning session: clarifying questions, approach proposals, then a structured task breakdown saved to `.omp/supipowers/plans/`.

For simple tasks, skip the brainstorming:

```
/supi:plan --quick add rate limiting middleware
```

### Running plans

```
/supi:run
```

Loads the latest plan and executes it with sub-agent orchestration. Tasks marked `[parallel-safe]` run concurrently (up to the configured limit). Sequential tasks respect their dependency chains.

The orchestration loop: dispatch batch → collect results → detect conflicts → retry failures → next batch. If interrupted, re-running picks up where it left off.

### Quality review

```
/supi:review           # uses default profile
/supi:review --quick   # fast: LSP diagnostics + AI scan
/supi:review --thorough  # deep: full AI review + code quality
/supi:review --full    # everything: tests + E2E + all gates
```

### QA

```
/supi:qa              # full test suite
/supi:qa --changed    # tests for changed files only
/supi:qa --e2e        # Playwright / E2E only
```

Detects your test framework on first run (vitest, jest, pytest, cargo test, go test) and caches it.

### Release

```
/supi:release
```

Analyzes commits since last tag, suggests a version bump, generates release notes, and publishes (npm, GitHub release, or manual — configured on first run).

## Configuration

Layered config: project (`.omp/supipowers/config.json`) overrides global (`~/.omp/supipowers/config.json`).

```
/supi:config                                    # view current config
/supi:config set orchestration.maxParallelAgents 5
/supi:config set defaultProfile thorough
```

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
    "modelPreference": "auto", // "auto" | "fast" | "capable" | "<model-id>"
  },
  "lsp": {
    "autoDetect": true,
    "setupGuide": true,
  },
  "qa": {
    "framework": null, // auto-detected and cached
    "command": null,
  },
}
```

## How it works

Supipowers is built on OMP's extension API. Every command is an immediate action — no state machine, no workflow phases.

**Sub-agent orchestration**: Plans are broken into batches of parallel-safe tasks. Each batch dispatches sub-agents with full OMP tool access (file editing, bash, LSP). After a batch completes, the orchestrator checks for file conflicts, retries failures, and moves to the next batch.

**Quality gates**: Composable checks selected by profile. LSP diagnostics feed real type errors. AI review catches logic issues. Test gates run your actual test suite. Gates report issues with severity levels (error/warning/info).

**LSP integration**: Sub-agents query LSP before making changes (find references, check diagnostics). If no LSP is active, everything still works — just better with it. Run `/supi:config` for setup guidance.

## Project structure

```
src/
  index.ts                     # extension entry point
  commands/                    # slash command handlers
    supi.ts, plan.ts, run.ts, review.ts, qa.ts, release.ts, config.ts, status.ts
  orchestrator/                # sub-agent dispatch & coordination
    batch-scheduler.ts, dispatcher.ts, result-collector.ts, conflict-resolver.ts, prompts.ts
  quality/                     # composable quality gates
    gate-runner.ts, lsp-gate.ts, ai-review-gate.ts, test-gate.ts
  qa/                          # QA pipeline
    detector.ts, runner.ts, report.ts
  lsp/                         # LSP integration
    detector.ts, bridge.ts, setup-guide.ts
  notifications/               # rich inline notifications
    renderer.ts, types.ts
  config/                      # configuration & profiles
    loader.ts, profiles.ts, defaults.ts, schema.ts
  storage/                     # persistence
    plans.ts, runs.ts, reports.ts
  release/                     # release automation
    analyzer.ts, notes.ts, publisher.ts
  types.ts                     # shared type definitions
skills/
  planning/SKILL.md
  code-review/SKILL.md
  debugging/SKILL.md
  qa-strategy/SKILL.md
bin/
  install.mjs                  # bunx installer
```

## Development

```bash
git clone https://github.com/pedromendes/supipowers.git
cd supipowers
bun install
bun run test        # run tests
bun run typecheck   # type checking
bun run test:watch  # watch mode
```

## Requirements

- [OMP](https://github.com/can1357/oh-my-pi) (oh-my-pi)
- [Bun](https://bun.sh) runtime

## License

MIT
