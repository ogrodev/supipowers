# Deterministic Quality Gates

**Date:** 2026-04-10
**Status:** Draft

## Goal

Replace the current profile-based quality selection with a deterministic gate system. Each gate becomes an executable unit with an explicit contract, explicit config, and explicit results. Users configure gates directly instead of relying on profile names or silent fallbacks.

## Motivation

The current quality flow is not deterministic enough:

- `defaultProfile` is a free-form string
- profile resolution silently falls back to `thorough`
- built-in profile names are magic strings wired into commands
- custom profile JSON is loaded without schema validation
- the gate runner is not a runner; it assembles prompt sections
- callers cannot tell the difference between a skipped check, a blocked check, and a passing check

This design removes profile indirection and makes quality behavior explicit:

- known gate IDs
- validated gate config
- deterministic gate selection
- structured gate input and output
- no silent fallback behavior

## Architecture

### Core model

Quality execution is built around a registry of gate definitions. Each gate is a first-class module that declares:

- `id` — canonical gate identifier
- `configSchema` — TypeBox schema for that gate's config
- `detect(projectFacts)` — optional setup-time heuristic used to suggest whether the gate should be configured and with which defaults
- `run(context, config)` — execution entry point
- `description` — user-facing explanation shown in setup and config UI

`projectFacts` and `detect()` are typed, shared contracts owned by `src/types.ts`, not ad hoc per gate. The setup boundary is:

```ts
interface ProjectFacts {
  cwd: string;
  packageScripts: Record<string, string>;
  lockfiles: string[];
  activeTools: string[];
  existingGates: Record<string, unknown>;
}

interface GateDetectionResult {
  suggestedConfig: Record<string, unknown> | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}
```

`detect()` returns `null` when the gate has no recommendation. Otherwise it returns a single `GateDetectionResult` for `setup.ts` to merge into the candidate config.

Profiles are removed from runtime behavior. The active quality configuration lives in `SupipowersConfig` under a dedicated `quality.gates` record keyed by gate ID.

### Gate contract

Each gate must share a common execution contract:

```ts
interface GateExecutionContext {
  cwd: string;
  changedFiles: string[];
  scopeFiles: string[];
  fileScope: "changed-files" | "all-files";
  exec: (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string; stderr: string; code: number }>;
  execShell: (command: string, opts?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string; stderr: string; code: number }>;
  getLspDiagnostics: (scopeFiles: string[], fileScope: "changed-files" | "all-files") => Promise<GateIssue[]>;
  createAgentSession: (opts: { cwd?: string; model?: string; thinkingLevel?: string | null }) => Promise<{ subscribe(handler: (event: unknown) => void): () => void; prompt(text: string, opts?: { expandPromptTemplates?: boolean }): Promise<void>; state: { messages: unknown[] }; dispose(): Promise<void>; }>;
  activeTools: string[];
  reviewModel?: {
    model?: string;
    thinkingLevel?: string | null;
  };
}

interface GateIssue {
  severity: "info" | "warning" | "error";
  message: string;
  file?: string;
  line?: number;
  detail?: string;
}

interface GateResult {
  gate: GateId;
  status: "passed" | "failed" | "skipped" | "blocked";
  summary: string;
  issues: GateIssue[];
  metadata?: Record<string, unknown>;
}
```

If git-based changed-file detection returns no files or cannot determine a diff, the runner sets `fileScope: "all-files"` and passes an empty `changedFiles` array. Gates must treat that as an explicit repo-wide scope, not as a blocked or empty-input condition.

Changed-file detection and repo-wide file selection are runner-owned contracts. The runner uses the current review behavior exactly: first `git diff --name-only HEAD`, then `git diff --name-only --cached`, then `git ls-files --others --exclude-standard` to include untracked files. In changed-files mode, the runner unions those results, filters them to existing reviewable files only, and passes the final list as both `changedFiles` and `scopeFiles`. If that list is empty or git is unavailable, the runner switches to `fileScope: "all-files"`, deterministically enumerates repo-wide reviewable files once, and passes that shared list as `scopeFiles` to every gate. For this spec, repo-wide `scopeFiles` means repository files anywhere under the project root whose extension is exactly one of: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, excluding `.omp/`, `node_modules/`, `dist/`, and `coverage/`.

Model resolution also stays outside individual gates. `/supi:review` resolves the existing `review` action model once and places the result on `GateExecutionContext.reviewModel`; `ai-review` consumes that context and must not perform its own model lookup.

This contract is intentionally small. The runner owns orchestration. The gate owns execution and result truthfulness.

### Config model

The new config shape is a typed gate record:

```ts
quality: {
  gates: {
    "lsp-diagnostics"?: { enabled: boolean };
    "ai-review"?: { enabled: boolean; depth: "quick" | "deep" };
    "test-suite"?:
      | { enabled: false; command?: string | null }
      | { enabled: true; command: string };
  };
}
```

First iteration is intentionally scoped to the gates that already belong to the current review flow: `lsp-diagnostics`, `ai-review`, and `test-suite`. The existing ambiguous `code-quality` flag and QA-driven `e2e` work are not part of this cutover; they require separate specs if they are reintroduced later as deterministic gates.

`DEFAULT_CONFIG` must provide `quality: { gates: {} }` and nothing more. There are no hidden built-in gate sets. If the resolved config contains no enabled gates, `/supi:review` must stop with an explicit message such as `No quality gates configured. Run /supi:config → Setup quality gates.`

`quality.gates["test-suite"].command` is the only source of truth for non-E2E test execution in `/supi:review`. It is executed as an opaque shell command string through `GateExecutionContext.execShell`; it is not whitespace-split into argv. This preserves current config UX for values like `npm test` and `go test ./...` while keeping execution semantics explicit in one place. `qa.command` must be removed from the shared config schema and from review/config command code during the cutover so the system does not carry two competing command sources. `/supi:qa` continues to use its own E2E-specific configuration flow.

This is the canonical source of truth. Runtime behavior is derived only from validated gate config plus explicit CLI filters.

### File structure

| File | Responsibility |
|---|---|
| `src/types.ts` | Shared types: `GateId`, `GateDefinition`, `GateResult`, config types, setup types |
| `src/config/schema.ts` | Validate the full config shape including `quality.gates` |
| `src/config/defaults.ts` | Default `quality.gates` to an empty record; remove builtin profiles |
| `src/quality/gates/*.ts` | One executable gate definition per file |
| `src/quality/registry.ts` | Canonical gate registry and gate lookup |
| `src/quality/runner.ts` | Resolve selected gates, execute them, aggregate results |
| `src/quality/ai-session.ts` | Typed adapter over raw agent-session APIs for structured AI gate execution |
| `src/quality/setup.ts` | Repo inspection, deterministic suggestions, AI-assisted setup orchestration |
| `src/storage/reports.ts` | Persist and load the new gate-based `ReviewReport` shape |
| `src/commands/review.ts` | Run configured gates; apply `--only` / `--skip` filters |
| `src/commands/config.ts` | Add interactive entry point for quality gate setup |
| `src/commands/status.ts` | Replace profile display with enabled-gate summary |
| `src/commands/supi.ts` | Replace profile/boolean-review summary with gate-based review status |
| `src/commands/doctor.ts` | Replace `defaultProfile` health output with quality-gate config health |
| `tests/config/*` | Config and validation tests |
| `tests/quality/*` | Gate and runner tests |

## Components

### Gate registry

The registry is the single authoritative list of supported gates. It prevents unknown identifiers from entering runtime logic and allows config validation to be derived from the same source that execution uses.

The registry must not be dynamically extensible in this change. Static registration keeps the system deterministic and testable.

### Gate runner

The runner replaces the current prompt-assembly role of `src/quality/gate-runner.ts`.

Responsibilities:

1. accept already-loaded, already-validated gate config from `src/commands/review.ts`
2. compute the configured gate set
3. apply CLI overrides such as `--only ai-review,lsp-diagnostics` and `--skip test-suite`
4. build shared execution context
5. execute gates in deterministic order
6. collect structured `GateResult[]`
7. build the final review report without collapsing status too early

Canonical gate order is fixed by the registry, not by object iteration or lexical sorting. For this spec the order is exactly: `lsp-diagnostics` → `test-suite` → `ai-review`.

### Individual gates

Each gate owns only one level of abstraction:

- setup-time applicability detection
- runtime execution for that gate
- shaping its own output into `GateResult`

First iteration defines exactly three executable gates:

- `lsp-diagnostics`
  - **Input:** `scopeFiles`, `fileScope`, active tools, and the runner-provided `getLspDiagnostics` capability
  - **Prerequisite:** at least one LSP tool is active
  - **Output:** diagnostics summarized into `GateIssue[]`
  - **All-files behavior:** the gate uses the runner-provided `scopeFiles` list and `getLspDiagnostics` provider for repo-wide analysis; it does not enumerate files or invent a diagnostics backend on its own
  - **Blocked when:** no LSP tool is active

- `test-suite`
  - **Input:** configured command string
  - **Prerequisite:** config variant `{ enabled: true, command: string }`
  - **Output:** command metadata (`command`, `exitCode`) plus parsed issues when the command fails
  - **Blocked when:** command execution cannot start or required runtime prerequisites are missing

- `ai-review`
  - **Input:** `scopeFiles`, `fileScope`, cwd, gate config, `reviewModel`, and the runner-provided `createAgentSession` capability
  - **All-files behavior:** the gate uses the same runner-provided `scopeFiles` list and frames the prompt as a repo-wide review over that exact file set
  - **Execution boundary:** the gate uses `createAgentSession` through `src/quality/ai-session.ts`, sends a strict review prompt, waits for the final assistant message, parses that message as structured JSON, and converts that result into `GateResult`
  - **Output contract:** `{ summary: string, issues: GateIssue[], recommendedStatus: "passed" | "failed" }`
  - **Blocked when:** the model response is missing, malformed, or cannot be parsed into the declared output contract

The runner never inspects free-form AI prose. It only consumes validated gate output.

### AI session adapter

Because `Platform.createAgentSession()` currently exposes loose `event: any` and `state.messages: any[]` surfaces, AI gates must not consume that API directly. Introduce a typed adapter in `src/quality/ai-session.ts` with a narrow contract such as:

```ts
interface StructuredAgentRunOptions {
  cwd: string;
  prompt: string;
  timeoutMs: number;
  model?: string;
  thinkingLevel?: string | null;
}

interface StructuredAgentRunResult {
  status: "ok" | "timeout" | "error";
  finalText: string | null;
  error?: string;
}
```

Responsibilities:

- create and dispose the agent session
- use the already-resolved `/supi:review` model settings passed from the command layer
- wait for completion or timeout
- read the final assistant message text from session state
- return a typed success/error result to the gate

Model resolution stays centralized in the review command flow. The AI gate and adapter consume the resolved settings; they do not re-run model selection logic. `ai-review` is responsible for turning `finalText` into structured JSON. The adapter is responsible only for session lifecycle and final-message extraction. This boundary makes the gate independently understandable and testable.

### Setup flow

`setupGates()` provides a guided way to configure quality gates without reintroducing magic names.

It gathers project facts first:

- `package.json` presence and scripts
- lockfiles / package manager signals
- active tools such as LSP
- existing `quality.gates` config if present

From those facts it builds a deterministic baseline suggestion.

Optional AI assistance sits on top of those facts, not instead of them. The model may propose a gate config, but only within a strict contract:

- allowed gate IDs are enumerated
- allowed config schema is provided
- project facts are provided explicitly
- output must be only a candidate config object plus explanation

The setup module validates the candidate before showing or saving it. Invalid proposals are rejected and surfaced to the user. They are never persisted silently.

If the user asks the model to revise the suggestion, each revision goes through the same validation path. The model is an advisor, not a persistence path.

### UI entry point

The existing interactive config pattern in `src/commands/config.ts` is reused. Add an option such as `Setup quality gates` that launches the guided setup flow.

This keeps quality setup discoverable and consistent with existing QA setup behavior.

## Data Flow

### 1. Setup-time flow

```text
User chooses "Setup quality gates"
  → setup.ts gathers project facts
  → registry.detect() functions contribute deterministic suggestions
  → optional AI-assisted step refines the candidate config
  → setup.ts validates the candidate against the real schema
  → user accepts or edits
  → setup.ts writes the project-local `quality.gates` subtree back to .omp/supipowers/config.json while preserving unrelated project-local config fields
```

The setup flow reads the merged default/global/project view, but `quality.gates` is a replace-on-merge subtree, not a recursively deep-merged record. This replacement rule is enforced by `src/config/loader.ts` for both strict runtime loads and tolerant inspection loads. Project-level `quality.gates` fully replaces inherited gate config for that subtree. Setup therefore updates only the project file's `quality.gates` field, preserving other project-local settings and avoiding materializing inherited global/default settings into the project file.


The AI-assisted step is advisory. Validation and persistence remain local responsibilities.
### 2. Runtime review flow

```text
User runs /supi:review [--only ...] [--skip ...]
  → review.ts loads config
  → config schema validates quality.gates
  → runner resolves enabled gates from config
  → runner applies explicit CLI filters
  → configured gates filtered out by CLI become `skipped` results
  → remaining selected gates build shared execution context
  → runner executes each gate in deterministic order
  → runner aggregates GateResult[] into ReviewReport
  → review.ts persists ReviewReport via src/storage/reports.ts
  → review command reports structured results
```

The review command owns persistence. The runner returns a `ReviewReport`; `src/commands/review.ts` saves it through `src/storage/reports.ts` before updating user-facing status surfaces.

User-visible result contract: after persistence, `/supi:review` emits a concise command result summary through the existing notification surface. It must show: `overallStatus`, per-status counts (`passed`, `failed`, `blocked`, `skipped`), per-gate status labels in canonical gate order, and the saved report path under `.omp/supipowers/reports/`. It does not steer the main session or open a new custom UI in this iteration.

### 3. Truthful result semantics

A gate result must distinguish the following states:

- `passed` — gate ran successfully and found no failing issues
- `failed` — gate ran and found problems, or command execution meaningfully failed
- `skipped` — gate was enabled in config but excluded for this invocation by `--only` or `--skip`
- `blocked` — gate was selected to run but could not run because prerequisites or contract requirements were not met

Gates that are disabled or absent in config are omitted from runtime results entirely. They are not reported as `skipped`. This distinction is required for callers and for future UI work.

### 4. Aggregate review report

`/supi:review` and `src/quality/runner.ts` must exchange a structured aggregate report, not just raw `GateResult[]`. The old `ReviewReport` shape with `{ profile, passed }` is removed. Replace it with a report that preserves aggregate truth:

```ts
interface ReviewReport {
  timestamp: string;
  selectedGates: GateId[];
  gates: GateResult[];
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    blocked: number;
  };
  overallStatus: "passed" | "failed" | "blocked";
}
```

`selectedGates` means the post-filter gate IDs the runner attempted to execute. It does not include configured gates that were turned into `skipped` results by `--only` or `--skip`; those appear only in `gates`.

`overallStatus` is `failed` if any gate failed, otherwise `blocked` if any gate was blocked, otherwise `passed`. There is no aggregate boolean because it loses information the system now knows.

## Command Behavior

### `/supi:review`

`/supi:review` no longer selects a profile. It executes the configured gate set.

Supported invocation overrides:

- `--only <comma-separated gate ids>` — run only the named enabled gates
- `--skip <comma-separated gate ids>` — exclude the named enabled gates

`--only` and `--skip` are mutually exclusive. Passing both in the same invocation is an explicit error. Repeating the same flag merges values by set union before validation.

Unknown gate IDs are explicit errors. Known gate IDs that are disabled or absent in config are also explicit errors when named in `--only` or `--skip`; the command must not silently treat them as omitted or produce an empty run.

If CLI filters leave no selected gates, `/supi:review` must stop with an explicit error rather than producing an empty report.

The legacy `--quick`, `--thorough`, `--full`, and `--profile` behavior is removed as part of the cutover.

### `/supi:config`

Add a quality setup entry point that:

- shows current gate configuration summary or validation errors from the tolerant inspection load
- launches setup guidance
- offers deterministic suggestion, AI-assisted suggestion, accept, revise, and cancel paths
- saves only validated config
- on cancel or validation failure, leaves the on-disk config unchanged

This command remains the user-facing entry point for configuration changes and recovery from invalid gate config.

## Error Handling

### Config errors

Config validation ownership is centralized in `src/config/loader.ts`. The loader exposes two paths: a strict validated load for runtime commands such as `/supi:review`, and a tolerant inspection load for commands that must diagnose or repair config such as `/supi:config`, `/supi:doctor`, `/supi`, and `/supi:status`. Both paths share the same `src/config/schema.ts` validation and parse-error detection logic; only the recovery behavior differs. The strict path throws a typed config-validation error containing path-level failures. The inspection path returns a typed `InspectionLoadResult` with `{ mergedConfig: Record<string, unknown>, effectiveConfig: SupipowersConfig | null, parseErrors: { source: "global" | "project"; path: string; message: string }[], validationErrors: { path: string; message: string }[] }`, so callers can render repair UI consistently without guessing which file failed or whether a usable effective config exists.




Examples:

- unknown gate key
- invalid gate option type
- required gate option missing
- unsupported enum value

### Setup errors

- inconclusive detection results are shown as uncertainty, not turned into fake defaults
- invalid AI suggestions are rejected and do not overwrite existing config
- user cancellation leaves config unchanged

### Execution errors

Command-based gates record meaningful execution metadata such as command and exit code.
AI-based gates must parse model output into the declared result shape. If parsing fails, the gate is `blocked`.
If `test-suite` is enabled, its config must contain a concrete command string. The runner does not invent or infer fallback commands at runtime.

The aggregate review result must preserve per-gate status and must not flatten `blocked` into `passed`.

## Testing

### Config tests

Replace profile tests with gate-config validation tests:

- valid `quality.gates` config passes
- unknown gate ID fails
- invalid per-gate options fail
- removed profile fields are no longer accepted
- `quality.gates` replacement semantics override inherited global config rather than deep-merging it

### Gate tests

Each gate must be individually testable:

- `detect()` suggests expected defaults from project facts
- `run()` returns `blocked` when prerequisites are missing
- command gates record execution metadata
- AI gates reject invalid contract output

### Runner tests

Runner tests must verify:

- deterministic gate ordering
- `--only` filtering marks configured-but-excluded gates as `skipped`
- `--skip` filtering marks configured-but-excluded gates as `skipped`
- disabled gates are omitted from results
- aggregate results preserve `passed` / `failed` / `skipped` / `blocked`

### Command tests

Add review command coverage proving it no longer resolves profiles and instead runs configured gates, proving an empty enabled gate set surfaces an explicit setup-required message, and proving the final notification summary includes `overallStatus`, per-status counts, per-gate statuses, and the saved report path.

Add setup/config coverage proving: deterministic suggestion works, invalid AI suggestions are rejected, cancel leaves config unchanged, and project-level `quality.gates` persistence replaces inherited gate config for that subtree.

Add command-level coverage for every user-facing consumer updated by the cutover:

- `status` shows enabled gate summary instead of `defaultProfile`
- `supi` shows the new aggregate `overallStatus` instead of `latestReport.passed`
- `doctor` reports quality-gate config health instead of `defaultProfile` parsing details

## Migration and Cutover

This is a full cutover.

Remove:

- `Profile` as the runtime selection model
- builtin profile definitions
- profile loading and saving helpers
- review command profile flags and UI
- tests that assert profile fallback behavior
- `defaultProfile` from config schema, defaults, config UI, and status/doctor surfaces
- the old `ReviewReport` shape based on `{ profile, passed }`
- `qa.command` as a shared-config input to `/supi:review`

Update all consumers that currently surface profile or boolean review state, including at minimum:

- `src/storage/reports.ts`
- `src/commands/supi.ts`
- `src/commands/status.ts`
- `src/commands/doctor.ts`

The system should tell the truth about the new design. Do not keep compatibility shims for profile names or dual report formats. Persisted legacy `review-*.json` files using the old `{ profile, passed }` shape are treated as stale: `src/storage/reports.ts` must ignore them by returning `null` rather than trying to coerce them into the new schema.

If a one-time config migration is implemented, it must be explicit and test-covered. It is optional and must not preserve profile semantics at runtime.

## Non-Goals

This change does not attempt to:

- introduce dynamic third-party gate plugins
- build a generalized workflow engine beyond quality gates
- integrate `/supi:qa` into `/supi:review` as an `e2e` gate in this iteration
- resurrect the ambiguous legacy `code-quality` gate without a separate deterministic spec
- build a large custom TUI for gate editing in the first iteration
- preserve legacy profile UX
