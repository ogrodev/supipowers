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

Profiles are removed from runtime behavior. The active quality configuration lives in `SupipowersConfig` under a dedicated `quality.gates` record keyed by gate ID.

### Gate contract

Each gate must share a common execution contract:

```ts
interface GateExecutionContext {
  cwd: string;
  changedFiles: string[];
  fileScope: "changed-files" | "all-files";
  platform: Platform;
  activeTools: string[];
}

interface GateIssue {
  severity: "info" | "warning" | "error";
  message: string;
  file?: string;
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

This contract is intentionally small. The runner owns orchestration. The gate owns execution and result truthfulness.

### Config model

The new config shape is a typed gate record:

```ts
quality: {
  gates: {
    "lsp-diagnostics"?: { enabled: boolean };
    "ai-review"?: { enabled: boolean; depth: "quick" | "deep" };
    "test-suite"?:
      | { enabled: false; command?: null }
      | { enabled: true; command: string };
  };
}
```

First iteration is intentionally scoped to the gates that already belong to the current review flow: `lsp-diagnostics`, `ai-review`, and `test-suite`. The existing ambiguous `code-quality` flag and QA-driven `e2e` work are not part of this cutover; they require separate specs if they are reintroduced later as deterministic gates.

`DEFAULT_CONFIG` must provide `quality: { gates: {} }` and nothing more. There are no hidden built-in gate sets. If the resolved config contains no enabled gates, `/supi:review` must stop with an explicit message such as `No quality gates configured. Run /supi:config → Setup quality gates.`

`quality.gates["test-suite"].command` is the only source of truth for non-E2E test execution in `/supi:review`. `qa.command` must be removed from the shared config schema and from review/config command code during the cutover so the system does not carry two competing command sources. `/supi:qa` continues to use its own E2E-specific configuration flow.

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

1. load validated gate config
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
  - **Input:** changed files and active tools
  - **Prerequisite:** at least one LSP tool is active
  - **Output:** diagnostics summarized into `GateIssue[]`
  - **Blocked when:** no LSP tool is active

- `test-suite`
  - **Input:** configured command string
  - **Prerequisite:** config variant `{ enabled: true, command: string }`
  - **Output:** command metadata (`command`, `exitCode`) plus parsed issues when the command fails
  - **Blocked when:** command execution cannot start or required runtime prerequisites are missing

- `ai-review`
  - **Input:** changed files, cwd, and gate config
  - **Execution boundary:** the gate creates a dedicated agent session via the platform, sends a strict review prompt, waits for the final assistant message, parses that message as structured JSON, and converts that result into `GateResult`
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
}

interface StructuredAgentRunResult {
  status: "ok" | "timeout" | "error";
  finalText: string | null;
  error?: string;
}
```

Responsibilities:

- create and dispose the agent session
- wait for completion or timeout
- read the final assistant message text from session state
- return a typed success/error result to the gate

`ai-review` is responsible for turning `finalText` into structured JSON. The adapter is responsible only for session lifecycle and final-message extraction. This boundary makes the gate independently understandable and testable.

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
  → validated config is written to .omp/supipowers/config.json
```

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

`overallStatus` is `failed` if any gate failed, otherwise `blocked` if any gate was blocked, otherwise `passed`. There is no aggregate boolean because it loses information the system now knows.

## Command Behavior

### `/supi:review`

`/supi:review` no longer selects a profile. It executes the configured gate set.

Supported invocation overrides:

- `--only <comma-separated gate ids>` — run only the named enabled gates
- `--skip <comma-separated gate ids>` — exclude the named enabled gates

Unknown gate IDs are explicit errors. Known gate IDs that are disabled or absent in config are also explicit errors when named in `--only` or `--skip`; the command must not silently treat them as omitted or produce an empty run.

If CLI filters leave no selected gates, `/supi:review` must stop with an explicit error rather than producing an empty report.

The legacy `--quick`, `--thorough`, `--full`, and `--profile` behavior is removed as part of the cutover.

### `/supi:config`

Add a quality setup entry point that:

- shows current gate configuration summary
- launches setup guidance
- saves only validated config

This command remains the user-facing entry point for configuration changes.

## Error Handling

### Config errors

Config validation errors must surface with exact paths and messages. Invalid config is not replaced with defaults at runtime.

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

Add review command coverage proving it no longer resolves profiles and instead runs configured gates, and proving an empty enabled gate set surfaces an explicit setup-required message.

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

The system should tell the truth about the new design. Do not keep compatibility shims for profile names or dual report formats.

If a one-time config migration is implemented, it must be explicit and test-covered. It is optional and must not preserve profile semantics at runtime.

## Non-Goals

This change does not attempt to:

- introduce dynamic third-party gate plugins
- build a generalized workflow engine beyond quality gates
- integrate `/supi:qa` into `/supi:review` as an `e2e` gate in this iteration
- resurrect the ambiguous legacy `code-quality` gate without a separate deterministic spec
- build a large custom TUI for gate editing in the first iteration
- preserve legacy profile UX
