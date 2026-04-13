# Repository Guidelines

## Project Overview

**supipowers** is an OMP-native TypeScript extension for the [oh-my-pi](https://github.com/oh-my-pi) coding agent. It adds agentic workflows on top of OMP's `ExtensionAPI`:

- `/supi:plan` — collaborative task planning with AI steering
- `/supi:review` — programmatic AI review pipeline (quick, deep, multi-agent)
- `/supi:checks` — deterministic quality gates
- `/supi:qa` — structured QA pipeline
- `/supi:release` — release automation
- `/supi:fix-pr` — PR review comment assessment and fixing
- `/supi:commit` — AI-powered commit with conventional messages
- `/supi:generate` — documentation drift detection
- `/supi:agents` — manage review agents

It is **not** a web application. It runs as a plugin inside the OMP runtime, registered via the `omp.extensions` field in `package.json`.

---

## Architecture & Data Flow

The system is a **command-dispatch pipeline** with no state machine:

```
OMP Runtime
    │
    ├── src/index.ts          ← extension entry point; creates platform adapter
    ├── src/bootstrap.ts      ← registers all slash commands and hooks
    │
    ├── src/commands/         ← one file per slash command
    │
    ├── src/config/           ← three-layer config loading (defaults → global → project)
    ├── src/platform/         ← platform abstraction (OMP adapter, types, progress, TUI colors)
    ├── src/storage/          ← markdown/JSON persistence (.omp/supipowers/)
    ├── src/quality/          ← composable check runner (lsp-diagnostics, lint, typecheck, test-suite, build)
    ├── src/review/           ← AI review pipeline (scope, runners, validation, fixing, consolidation)
    ├── src/planning/         ← plan approval UI flow (agent_end hook)
    ├── src/notifications/    ← notification rendering and emission
    ├── src/lsp/              ← LSP availability detection via platform.getActiveTools()
    ├── src/mcp/              ← MCP server management (registry, activation, lifecycle)
    ├── src/context-mode/     ← context window protection hooks
    ├── src/release/          ← release automation logic
    ├── src/fix-pr/           ← PR review comment fixing logic
    ├── src/docs/             ← documentation drift detection
    ├── src/git/              ← git operations
    ├── src/qa/               ← QA pipeline logic
    ├── src/visual/           ← visual companion server
    ├── src/utils/            ← shared utilities
    ├── src/debug/            ← debug logger (SUPI_DEBUG-gated JSONL tracing)
    ├── src/discipline/       ← discipline modules (debugging, tdd, verification, receiving-review)
    └── src/deps/             ← dependency detection
```

**Data flow for `/supi:plan`:**

1. Load config + profile → build planning prompt from skill + context
2. Steer AI session through planning phases (scope → decompose → estimate → verify)
3. Save plan to `.omp/supipowers/plans/`
4. Present approval UI via `ctx.ui.custom()` — user approves, edits, or rejects
5. On approval, execute tasks in the same session via steer messages

**Data flow for `/supi:review`:**

1. Select a review scope (PR-style, uncommitted, commit, or custom)
2. Resolve review level (quick / deep / multi-agent) and run headless `createAgentSession()` reviewers
3. Optionally validate findings against actual code, consolidate multi-agent output, and apply safe auto-fixes
4. Persist the session to `.omp/supipowers/reviews/` and optionally rerun the same review in a loop after fixes

**`/supi:plan`** uses `platform.sendMessage({ deliverAs: 'steer' })` to steer the active AI session.
**`/supi:review`** uses headless `createAgentSession()` runs with structured JSON validation at every step.
**`/supi:checks`** remains deterministic and runs configured gates without AI orchestration.
---

## Key Directories

```
supipowers/
├── src/
│   ├── index.ts              # Extension entry point (export default supipowers(api))
│   ├── bootstrap.ts          # Registers all slash commands and event hooks
│   ├── types.ts              # ALL shared types — single source of truth
│   ├── commands/             # One file per slash command
│   ├── platform/             # Platform abstraction (OMP adapter, types, progress)
│   ├── planning/             # Plan approval UI flow (agent_end hook)
│   ├── review/               # AI review pipeline modules and default review-agent assets
│   ├── config/               # loader.ts (3-layer merge), defaults.ts, model config/resolver
│   ├── storage/              # plan/report/review session persistence
│   ├── quality/              # deterministic quality gates
│   ├── lsp/                  # detector.ts
│   ├── notifications/        # renderer.ts
│   ├── mcp/                  # MCP server management
│   ├── context-mode/         # context window protection hooks
│   ├── release/              # release automation logic
│   ├── fix-pr/               # PR review comment fixing logic
│   ├── docs/                 # documentation drift detection
│   ├── git/                  # git operations
│   ├── qa/                   # QA pipeline logic
│   ├── visual/               # visual companion server
│   ├── utils/                # shared utilities
│   ├── debug/                # debug logger (SUPI_DEBUG-gated JSONL tracing)
│   ├── discipline/           # discipline modules (debugging, tdd, verification, receiving-review)
│   └── deps/                 # dependency detection
├── tests/                    # Mirrors src/ structure — tests/<module>/<unit>.test.ts
├── skills/                   # OMP skills used by steer-based commands or manual prompting
│   ├── planning/SKILL.md
│   ├── code-review/SKILL.md
│   ├── debugging/SKILL.md
│   ├── qa-strategy/SKILL.md
│   ├── fix-pr/SKILL.md
│   ├── release/SKILL.md
│   ├── tdd/SKILL.md
│   ├── verification/SKILL.md
│   ├── receiving-code-review/SKILL.md
│   ├── context-mode/SKILL.md
│   └── creating-supi-agents/SKILL.md
├── bin/
│   └── install.mjs           # Interactive CLI installer (@clack/prompts)
├── docs/
│   └── supipowers/
│       ├── specs/            # Authoritative v2 design spec
│       └── plans/            # Implementation plan with step-by-step tasks
└── .omp/supipowers/          # Runtime data (gitignored)
    ├── config.json           # Project-level config override
    ├── plans/                # Saved plan markdown files
    ├── review-agents/        # User-configurable AI review agents + config.yml
    └── reviews/              # Persisted /supi:review sessions

---

## Important Files

|File|Purpose|
|---|---|
|`src/index.ts`|Extension entry point — `export default function supipowers(api: any)`; delegates to `bootstrap()`|
|`src/types.ts`|Canonical types: plans, checks, review pipeline sessions/findings, models, etc. — add shared types here only|
|`src/commands/ai-review.ts`|`/supi:review` TUI pipeline orchestrator|
|`src/commands/review.ts`|`/supi:checks` deterministic quality-gate command|
|`src/review/agent-loader.ts`|Seeds/loads `.omp/supipowers/review-agents/` config + markdown agent definitions|
|`src/review/multi-agent-runner.ts`|Parallel multi-agent review execution with per-agent model overrides|
|`src/storage/review-sessions.ts`|Review session persistence under `.omp/supipowers/reviews/`|
|`src/config/defaults.ts`|`DEFAULT_CONFIG` — built-in default configuration|
|`src/planning/approval-flow.ts`|Plan approval UI flow (agent_end hook)|
|`.omp/supipowers/review-agents/config.yml`|Project-local review-agent pipeline config materialized on first `/supi:review` run|
|`.omp/supipowers/specs/2026-03-10-supipowers-v2-design.md`|Authoritative v2 design spec; read before any architectural change|
|`package.json`|`omp.extensions` field registers `./src/index.ts` with the OMP runtime|
|`tsconfig.json` / `tsconfig.build.json`|Base config (includes tests) vs. build config (excludes tests)|

---

## Development Commands

Runtime preference: **Bun** (`bun.lock` is present; OMP installs via `bun`).

```bash
# Install dependencies
bun install

# Run all tests (one-shot)
bun test           # runs bun's built-in test runner

# Watch mode
bun run test:watch  # or: npm run test:watch

# Type-check without emitting
bun run typecheck   # tsc --noEmit

# Build (emit to dist/, excludes tests)
bun run build       # tsc -p tsconfig.build.json

# Interactive installer (end-user onboarding)
bunx supipowers
```

---

## Runtime & Tooling

| Concern           | Choice                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| Runtime           | **Bun** (preferred) — `bun.lock` present; scripts also work under Node |
| Package manager   | **Bun** (`bun install`, `bun run`)                                     |
| Language          | TypeScript 5.9+, ESNext target, ESM (`"type": "module"`)               |
| Module resolution | `bundler` in tsconfig (both bun and bundlers resolve correctly)        |
| Test runner       | **bun:test** (Bun's built-in test runner)                               |
| Build             | Plain **tsc** (`tsc -p tsconfig.build.json`)                           |
| Linter/formatter  | **None configured** — no ESLint, Biome, or Prettier                    |
| CI                | **None** — quality checks are fully manual                             |

Peer dependencies (`@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-tui`, `@sinclair/typebox`) are provided by the OMP host; they are devDependencies only for type-checking during development.

---

## Code Conventions & Patterns

### Types

- **All shared types live in `src/types.ts`** — never duplicate a type across modules.
- Use TypeBox (`@sinclair/typebox`) for runtime-validated schemas (see existing usage patterns before adding new schemas).
- Prefer discriminated unions and enums over loosely-typed strings; the domain types (e.g., `TaskComplexity`) are the ground truth.

### Module structure

- One slash command per file in `src/commands/`. Each exports a single async handler function.
- No barrel `index.ts` re-exports inside subdirectories; import directly from the file.

### Config loading

Three-layer deep-merge, lowest to highest priority:

1. `DEFAULT_CONFIG` in `src/config/defaults.ts`
2. Global: `~/.omp/supipowers/config.json`
3. Project: `.omp/supipowers/config.json`

Use `loadConfig()` from `src/config/loader.ts`; never access config files directly in commands.

### Persistence

- Plans: Markdown files with YAML frontmatter in `.omp/supipowers/plans/`. Parse via `src/storage/plans.ts`.
- Always go through the storage layer; no raw `fs` calls in command code.

### AI session steering

Use `platform.sendMessage({ deliverAs: 'steer' })` to steer the active AI session. Load skill content via the skills loader before building prompts.

### Error handling

- Errors propagate up to the command handler; commands emit a notification with `type: 'error'` on failure.

### Async patterns

- No top-level `await` in library code; async is explicit in command handlers.

---

## Testing & QA

### Framework

**bun:test** — Bun's built-in test runner. Test globals (`describe`, `test`, `expect`, `beforeEach`, `afterEach`) are available without imports. Files that use `mock()` must import it explicitly: `import { mock } from "bun:test"` — and when doing so, must also import all other test functions used in that file.

### Test structure

```
tests/
├── commands/      # command handler tests
├── config/        # loader.test.ts, model config tests
├── context/       # context command tests
├── context-mode/  # context-mode hook tests
├── deps/          # dependency detection tests
├── discipline/    # discipline module tests
├── docs/          # doc drift tests
├── fix-pr/        # fix-pr tests
├── git/           # git operation tests
├── integration/   # extension.test.ts (smoke test: all commands registered)
├── lsp/           # detector.test.ts
├── mcp/           # MCP management tests
├── notifications/ # renderer.test.ts
├── planning/      # planning module tests
├── platform/      # platform adapter tests
├── qa/            # QA pipeline tests
├── quality/       # gate-runner.test.ts
├── release/       # release automation tests
├── review/        # review pipeline tests
├── storage/       # plans.test.ts, review session tests
└── visual/        # visual companion tests
```

`tests/` mirrors `src/` one-to-one. Place new tests at `tests/<same-path-as-src>/<module>.test.ts`.

### Patterns

**Filesystem tests — tmpdir fixture:**

```typescript
let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

**Inline platform mock (import `mock` from `bun:test`):**

```typescript
import { describe, expect, mock, test } from "bun:test";

const mockPlatform = {
  registerCommand: mock(),
  getCommands: mock(() => []),
  on: mock(),
  sendMessage: mock(),
  sendUserMessage: mock(),
  getActiveTools: mock(() => []),
  registerMessageRenderer: mock(),
  createAgentSession: mock(),
  exec: mock(),
  paths: createPaths(),
  capabilities: {
    agentSessions: true,
    compactionHooks: false,
    customWidgets: false,
    registerTool: false,
  },
} as any;
```

**Factory helpers for typed test data:**

```typescript
function task(id: number): PlanTask {
  return {
    id,
    name: `task-${id}`,
    description: `Task ${id}`,
    files: [],
    criteria: "",
    complexity: "small",
  };
}
```

**Inline string fixtures for parser tests** (see `tests/storage/plans.test.ts`): define a `SAMPLE_PLAN` const with realistic markdown, parse it, and assert structure.

### Coverage

No coverage thresholds are configured. There is no CI pipeline; tests must be run manually before committing.

---

## Skills

Skills are OMP-consumed markdown prompt files in `skills/`. Steer-based commands load them at runtime; the programmatic `/supi:review` pipeline instead uses versioned review-agent templates under `src/review/default-agents/` and materializes them into `.omp/supipowers/review-agents/` on demand.

| Skill               | Path                                    | Used by                                    |
| ------------------- | --------------------------------------- | ------------------------------------------ |
| Planning            | `skills/planning/SKILL.md`              | `/supi:plan`                               |
| Code review         | `skills/code-review/SKILL.md`           | Manual prompting / reusable review guidance |
| QA strategy         | `skills/qa-strategy/SKILL.md`           | `/supi:qa`                                 |
| Fix PR              | `skills/fix-pr/SKILL.md`                | `/supi:fix-pr`                             |
| Debugging           | `skills/debugging/SKILL.md`             | Agent sessions                             |
| TDD                 | `skills/tdd/SKILL.md`                   | Agent sessions                             |
| Verification        | `skills/verification/SKILL.md`          | Agent sessions                             |
| Receiving review    | `skills/receiving-code-review/SKILL.md` | Agent sessions                             |
| Release             | `skills/release/SKILL.md`               | `/supi:release`                            |
| Context mode        | `skills/context-mode/SKILL.md`          | Context window guidance                    |
| Creating agents     | `skills/creating-supi-agents/SKILL.md`  | Agent creation guidance                    |