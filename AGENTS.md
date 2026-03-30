# Repository Guidelines

## Project Overview

**supipowers** is an OMP-native TypeScript extension (v0.5.0) for the [oh-my-pi](https://github.com/oh-my-pi) coding agent. It adds agentic workflows on top of OMP's `ExtensionAPI`:

- `/supi:plan` — collaborative task planning with AI steering
- `/supi:run` — parallel sub-agent orchestration with batch scheduling and conflict detection
- `/supi:review` — composable quality-gate code review
- `/supi:qa` — structured QA pipeline
- `/supi:release` — release automation

It is **not** a web application. It runs as a plugin inside the OMP runtime, registered via the `omp.extensions` field in `package.json`. Currently v0.5.0 / active early development; sub-agent dispatch (`executeSubAgent` in `src/orchestrator/dispatcher.ts`) is still stubbed pending OMP runtime integration.

---

## Architecture & Data Flow

The system is a **command-dispatch pipeline** with no state machine:

```
OMP Runtime
    │
    ├── src/index.ts          ← extension entry point; registers all slash commands
    │
    ├── src/commands/         ← one file per slash command
    │       run.ts            ← orchestration entry point
    │       plan.ts, review.ts, qa.ts, release.ts, sync.ts, status.ts, reset.ts
    │
    ├── src/orchestrator/     ← parallelism engine
    │       batch-scheduler   → groups PlanTasks into dependency-aware RunBatches
    │       dispatcher        → calls executeSubAgent per task, maps results
    │       result-collector  → aggregates per-batch + overall summaries
    │       conflict-resolver → detects files touched by multiple agents, builds merge prompt
    │
    ├── src/config/           ← three-layer config loading (defaults → global → project)
    ├── src/storage/          ← markdown/JSON persistence (.omp/supipowers/)
    ├── src/quality/          ← composable gate runner (lsp-diagnostics, ai-review, …)
    ├── src/lsp/              ← LSP availability detection via pi.getActiveTools()
    └── src/notifications/    ← notification rendering and emission
```

**Data flow for `/supi:run`:**

1. Load config + profile → resolve plan from `.omp/supipowers/plans/`
2. `batch-scheduler` groups tasks into `RunBatch[]` respecting `[parallel-safe]` / `[sequential: depends on N]` annotations
3. Each batch runs via `Promise.all(dispatch)` → results collected into `RunManifest`
4. Blocked tasks trigger `dispatchFixAgent` retry (up to `maxFixRetries`)
5. `conflict-resolver` flags files touched by multiple agents
6. Manifest written to `.omp/supipowers/runs/<run-id>/`, notification emitted

**`/supi:plan` and `/supi:review`** use `pi.sendMessage({ deliverAs: 'steer' })` to steer the active AI session — no subprocess.

---

## Key Directories

```
supipowers/
├── src/
│   ├── index.ts              # Extension entry point (export default supipowers(pi))
│   ├── types.ts              # ALL shared types — single source of truth
│   ├── commands/             # One file per slash command
│   ├── orchestrator/         # Batch scheduler, dispatcher, result collector, conflict resolver
│   ├── config/               # loader.ts (3-layer merge), defaults.ts (profiles)
│   ├── storage/              # plans.ts (markdown + YAML frontmatter), runs.ts (JSON manifests)
│   ├── quality/              # gate-runner.ts (composable review gates)
│   ├── lsp/                  # detector.ts
│   └── notifications/        # renderer.ts
├── tests/                    # Mirrors src/ structure — tests/<module>/<unit>.test.ts
├── skills/                   # OMP skills loaded by plan/review/qa commands
│   ├── planning/SKILL.md
│   ├── code-review/SKILL.md
│   ├── debugging/SKILL.md
│   └── qa-strategy/SKILL.md
├── bin/
│   └── install.mjs           # Interactive CLI installer (@clack/prompts)
├── docs/
│   └── supipowers/
│       ├── specs/            # Authoritative v2 design spec
│       └── plans/            # Implementation plan with step-by-step tasks
└── .omp/supipowers/          # Runtime data (gitignored)
    ├── config.json           # Project-level config override
    ├── plans/                # Saved plan markdown files
    └── runs/                 # Run manifests and per-agent result JSON
```

---

## Important Files

| File                                                       | Purpose                                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                             | Extension entry point — `export default function supipowers(pi: ExtensionAPI)`                                                           |
| `src/types.ts`                                             | Canonical types: `PlanTask`, `Plan`, `AgentResult`, `RunBatch`, `RunManifest`, `SupipowersConfig`, `Profile`, etc. — add types here only |
| `src/config/defaults.ts`                                   | `DEFAULT_CONFIG` and `BUILTIN_PROFILES` (quick / thorough / full-regression)                                                             |
| `src/orchestrator/dispatcher.ts`                           | `executeSubAgent` stub — the integration point for OMP sub-agent API                                                                     |
| `.omp/supipowers/specs/2026-03-10-supipowers-v2-design.md` | Authoritative v2 design spec; read before any architectural change                                                                       |
| `package.json`                                             | `omp.extensions` field registers `./src/index.ts` with the OMP runtime                                                                   |
| `tsconfig.json` / `tsconfig.build.json`                    | Base config (includes tests) vs. build config (excludes tests)                                                                           |

---

## Development Commands

Runtime preference: **Bun** (`bun.lock` is present; OMP installs via `bun`).

```bash
# Install dependencies
bun install

# Run all tests (one-shot)
bun test           # or: npm test  (calls vitest run)

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
| Test runner       | **Vitest** v4 with `globals: true`                                     |
| Build             | Plain **tsc** (`tsc -p tsconfig.build.json`)                           |
| Linter/formatter  | **None configured** — no ESLint, Biome, or Prettier                    |
| CI                | **None** — quality checks are fully manual                             |

Peer dependencies (`@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-tui`, `@sinclair/typebox`) are provided by the OMP host; they are devDependencies only for type-checking during development.

---

## Code Conventions & Patterns

### Types

- **All shared types live in `src/types.ts`** — never duplicate a type across modules.
- Use TypeBox (`@sinclair/typebox`) for runtime-validated schemas (see existing usage patterns before adding new schemas).
- Prefer discriminated unions and enums over loosely-typed strings; the domain types (e.g., `AgentStatus`, `TaskComplexity`, `TaskParallelism`) are the ground truth.

### Module structure

- One slash command per file in `src/commands/`. Each exports a single async handler function.
- Orchestration logic lives in `src/orchestrator/`, not inside command files.
- No barrel `index.ts` re-exports inside subdirectories; import directly from the file.

### Config loading

Three-layer deep-merge, lowest to highest priority:

1. `DEFAULT_CONFIG` in `src/config/defaults.ts`
2. Global: `~/.omp/supipowers/config.json`
3. Project: `.omp/supipowers/config.json`

Use `loadConfig()` from `src/config/loader.ts`; never access config files directly in commands.

### Persistence

- Plans: Markdown files with YAML frontmatter in `.omp/supipowers/plans/`. Parse via `src/storage/plans.ts`.
- Run manifests: JSON under `.omp/supipowers/runs/<run-id>/manifest.json`. Agent results at `agents/task-N.json`.
- Always go through the storage layer; no raw `fs` calls in command or orchestrator code.

### AI session steering

Use `pi.sendMessage({ deliverAs: 'steer' })` to steer the active AI session. Load skill content via the skills loader before building prompts. Do **not** call `pi.sendMessage` directly from orchestrator code — that belongs in commands.

### Error handling

- Errors propagate up to the command handler; commands emit a notification with `type: 'error'` on failure.
- The `dispatchFixAgent` retry loop is bounded by `config.maxFixRetries`; exhausted retries produce `status: 'blocked'` — they do not throw.
- `batch-scheduler` is deadlock-safe: if no task is ready, it forces the first remaining task.

### Async patterns

- `Promise.all` for parallel batch dispatch; sequential between batches.
- No top-level `await` in library code; async is explicit in command handlers.

---

## Testing & QA

### Framework

**Vitest** v4, configured in `vitest.config.ts`. Test globals (`describe`, `test`, `expect`, `vi`) are available without imports.

### Test structure

```
tests/
├── config/        # loader.test.ts, profiles.test.ts
├── integration/   # extension.test.ts (smoke test: all commands registered)
├── lsp/           # detector.test.ts
├── notifications/ # renderer.test.ts
├── orchestrator/  # batch-scheduler.test.ts
├── qa/            # detector.test.ts
├── quality/       # gate-runner.test.ts
└── storage/       # plans.test.ts, runs.test.ts
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

**Inline `pi` SDK mock (no `vi.mock` calls at module level):**

```typescript
const mockPi = {
  registerCommand: vi.fn(),
  on: vi.fn(),
  sendMessage: vi.fn(),
  getActiveTools: vi.fn(() => []),
  exec: vi.fn(),
} as any;
```

**Factory helpers for typed test data:**

```typescript
function task(id: number, parallelism: PlanTask["parallelism"]): PlanTask {
  return {
    id,
    name: `task-${id}`,
    description: `Task ${id}`,
    files: [],
    criteria: "",
    complexity: "small",
    parallelism,
  };
}
```

**Inline string fixtures for parser tests** (see `tests/storage/plans.test.ts`): define a `SAMPLE_PLAN` const with realistic markdown, parse it, and assert structure.

### Coverage

No coverage thresholds are configured. There is no CI pipeline; tests must be run manually before committing.

---

## Skills

Skills are OMP-consumed markdown prompt files in `skills/`. They are loaded at runtime by command handlers (not bundled at build time). When adding or modifying a command that steers the AI, update the corresponding skill:

| Skill       | Path                          | Used by            |
| ----------- | ----------------------------- | ------------------ |
| Planning    | `skills/planning/SKILL.md`    | `/supi:plan`       |
| Code review | `skills/code-review/SKILL.md` | `/supi:review`     |
| Debugging   | `skills/debugging/SKILL.md`   | `dispatchFixAgent` |
| QA strategy | `skills/qa-strategy/SKILL.md` | `/supi:qa`         |
