# Migrate QA Pipeline from `@playwright/test` to `playwright-cli`

**Date:** 2026-03-29
**Status:** Draft
**Scope:** Replace the per-project `@playwright/test` dependency with the global `@playwright/cli` (`playwright-cli`) binary across the entire QA pipeline.

---

## Problem

The current `/supi:qa` pipeline installs `@playwright/test` as a dev dependency into the user's project. This pollutes their `package.json`, downloads browser binaries into their `node_modules`, and fails when the project uses a different package manager or has conflicting Playwright versions. The pipeline should work without touching the user's project dependencies.

## Solution

Replace `@playwright/test` (per-project) with `@playwright/cli` (global install). The `playwright-cli` binary provides both interactive browser automation (for flow discovery) and test suite execution (for regression testing). The user installs it once globally; supipowers never modifies their project.

## Architecture

The existing 4-phase pipeline structure stays intact:

```
flow-discovery → test-generation → execution → reporting
```

What changes is the execution engine underneath each phase.

### Before

```
Agent writes .spec.ts files
  → npx playwright test runs them
  → JSON output parsed
  → Results reported
```

### After

```
Discovery: agent uses playwright-cli open/snapshot/click/screenshot interactively
Generation: agent writes .spec.ts files (Playwright test syntax)
Execution: playwright-cli runs the test suite
Reporting: results collected and reported (unchanged)
```

### Dependency change

| Before | After |
| --- | --- |
| `@playwright/test` installed per-project via `ensure-playwright.sh` | `@playwright/cli` installed globally by the user |
| `npx playwright test` for execution | `playwright-cli` commands for discovery + execution |
| Browser picker in setup wizard (chromium/firefox/webkit) | playwright-cli manages browser selection internally |

## Component Design

### 1. Scripts Layer (`src/qa/scripts/`)

**Delete `ensure-playwright.sh`.**
No longer needed. Dependency checking moves to `src/deps/registry.ts`.

**Rewrite `run-e2e-tests.sh`.**
Replace `npx playwright test $TEST_DIR --reporter=json` with `playwright-cli` test execution. The script still:
- Accepts test directory, results directory, and base URL as arguments
- Captures JSON output
- Parses results into a compact summary
- Returns non-zero on failure

The exact `playwright-cli` invocation for running a test suite replaces the `npx playwright test` call.

**Keep unchanged:**
- `start-dev-server.sh` (playwright-agnostic)
- `stop-dev-server.sh` (playwright-agnostic)
- `detect-app-type.sh` (playwright-agnostic)

**Keep `discover-routes.sh` as a hint source.**
The script's regex-based route scanning still provides useful starting points for the agent. But it is no longer the primary discovery mechanism. The agent uses `playwright-cli` interactive exploration as the source of truth and treats `discover-routes.sh` output as navigation hints.

### 2. Types (`src/qa/types.ts`)

Simplify `PlaywrightConfig`:

```typescript
// Before
interface PlaywrightConfig {
  browser: "chromium" | "firefox" | "webkit";
  headless: boolean;
  timeout: number;
}

// After
interface PlaywrightConfig {
  headless: boolean;
  timeout: number;
}
```

The `browser` field is removed because `playwright-cli` manages browser selection internally.

`E2eQaConfig` continues to reference `PlaywrightConfig` with no structural change.

### 3. Config (`src/qa/config.ts`)

Update `DEFAULT_E2E_QA_CONFIG`:

```typescript
// Before
playwright: {
  browser: "chromium",
  headless: true,
  timeout: 30000,
}

// After
playwright: {
  headless: true,
  timeout: 30000,
}
```

### 4. Command (`src/commands/qa.ts`)

**Setup wizard changes:**
- Remove the browser picker step (Step 4 in the current wizard). Three fewer TUI interactions.
- Step count goes from 5 to 4: app type → dev command → port → max retries.

**Playwright check (Step 2) changes:**
- Replace the `ensure-playwright.sh` call with a direct `playwright-cli --version` check via `platform.exec`.
- If missing: emit a notification with install instructions (`npm install -g @playwright/cli@latest`) and a warning that the pipeline will proceed but execution may fail.
- Do not attempt to install anything into the user's project.

**Headless flag:**
- The `headless` config value maps to the presence/absence of `--headed` on `playwright-cli open` commands. Default is headless (no flag).

### 5. Prompt Builder (`src/qa/prompt-builder.ts`)

This is the largest change. The orchestrator prompt is rewritten in three areas:

**Discovery phase instructions:**
Replace "use `discover-routes.sh` output" with interactive exploration instructions:
1. Run `playwright-cli open <baseUrl>` to launch the browser
2. Run `playwright-cli snapshot` to get element refs
3. Navigate using `playwright-cli click <ref>`, `playwright-cli goto <url>`
4. Take `playwright-cli screenshot` at key points
5. Build flow catalog from observed pages and interactions

The `discover-routes.sh` output is included as "starting hints" so the agent has navigation targets, but the interactive exploration is authoritative.

**Test generation instructions:**
Still instructs the agent to write `.spec.ts` files. The code examples update to reflect any patterns needed for `playwright-cli` execution. The agent writes standard Playwright test files.

**Execution instructions:**
References to `run-e2e-tests.sh` update to reflect the rewritten script. Script Paths section in the prompt updates from `ensure-playwright.sh` + `run-e2e-tests.sh` to just `run-e2e-tests.sh`.

**What stays the same:**
- Overall prompt structure (context, phases, regression handling, reporting format)
- Session ledger references
- Phase advancement logic
- Result collection format

### 6. Deps Registry (`src/deps/registry.ts`)

Add new dependency entry:

```typescript
{
  name: "playwright-cli",
  binary: "playwright-cli",
  required: false,
  category: "testing",  // new category
  description: "Browser automation CLI for E2E testing",
  checkFn: (exec) => checkBinary(exec, "playwright-cli"),
  installCmd: "npm install -g @playwright/cli@latest",
  url: "https://github.com/microsoft/playwright-cli",
}
```

The `"testing"` category is new alongside existing `"core"`, `"mcp"`, `"lsp"`.

### 7. Skill (`skills/qa-strategy/SKILL.md`)

Rewrite the Playwright section to cover `playwright-cli` usage:
- Drop all references to `@playwright/test` imports, `npx playwright`, project-level installation
- Replace with `playwright-cli` command patterns: `open`, `snapshot`, `click`, `fill`, `screenshot`
- Include discovery workflow examples (open → snapshot → navigate → catalog)
- Include test execution workflow examples
- Keep testing strategy content (what to test, how to structure flows, regression handling)

### 8. README (`README.md`)

Two changes:
1. **Requirements table:** Add `playwright-cli` entry under a "Testing" category with install command `npm install -g @playwright/cli@latest`.
2. **QA command description:** Update wording to mention `playwright-cli` instead of generic "Playwright / E2E".

## Error Handling

**playwright-cli not installed.** Command checks via deps registry. If missing, emits notification with install instructions and exits early. No silent installs.

**playwright-cli crashes mid-session.** Existing phase ledger tracks status (pending/running/completed/failed). Failed phases can be resumed by re-running `/supi:qa`. No change needed.

**Browser fails to launch.** `playwright-cli open` returns non-zero exit code. Prompt builder includes a diagnostic note telling the agent to check `playwright-cli --version` if `open` fails.

**Headless vs headed.** The `headless` config flag maps to the absence/presence of `--headed` on `playwright-cli open`. Default is headless.

**Version compatibility.** No pinned version. Deps registry uses `@latest` for install. If CLI interface changes, prompt builder instructions and `run-e2e-tests.sh` are the update points.

## Testing Strategy

| Test file | What changes |
| --- | --- |
| `tests/qa/config.test.ts` | Update assertions for simplified `PlaywrightConfig` (no `browser` field) |
| `tests/qa/types.test.ts` | Update type validation for simplified config |
| `tests/qa/prompt-builder.test.ts` | Verify prompts reference `playwright-cli` commands, not `npx playwright` |
| `tests/qa/session.test.ts` | No changes (session lifecycle is playwright-agnostic) |
| `tests/qa/matrix.test.ts` | No changes (matrix logic is playwright-agnostic) |
| Deps registry test | Add test for new `playwright-cli` dependency entry |

No integration/E2E tests for the CLI itself (requires a running browser). Tests verify that correct commands and prompts are generated.

## Files Affected

| Action | File |
| --- | --- |
| Modify | `src/qa/types.ts` |
| Modify | `src/qa/config.ts` |
| Modify | `src/commands/qa.ts` |
| Rewrite | `src/qa/prompt-builder.ts` |
| Rewrite | `src/qa/scripts/run-e2e-tests.sh` |
| Delete | `src/qa/scripts/ensure-playwright.sh` |
| Modify | `src/deps/registry.ts` |
| Rewrite | `skills/qa-strategy/SKILL.md` |
| Modify | `README.md` |
| Modify | `tests/qa/config.test.ts` |
| Modify | `tests/qa/types.test.ts` |
| Modify | `tests/qa/prompt-builder.test.ts` |
