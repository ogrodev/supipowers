# Supipowers Quickstart

## Install

### Local package install (recommended while developing)
```bash
cd /your/project
pi install /absolute/path/to/supipowers -l
```

### npm install (when published)
```bash
pi install npm:supipowers
```

## Verify commands are available
Inside Pi, run:
```text
/sp-status
```

## Basic workflow
```text
/sp-start Implement login flow with tests
# Supipowers auto-approves + auto-plans and asks to execute now
/sp-execute
/sp-finish merge --review-pass
```

`/sp-start` now auto-advances workflow phases and prepares a plan artifact immediately.
Use `/sp-execute` when you want to resume later or retry execution.
If you need to redo a phase, use `/sp-rewind` and pick the target state from the UI.

Visualization defaults to a compact footer one-liner. Toggle with `F6` (fallback: `Alt+V`) to switch between compact and full view.

If your terminal does not pass shortcut keys reliably, use:
```text
/sp-view compact
/sp-view full
/sp-view status
```
## Development mode (without install)
```bash
cd /absolute/path/to/supipowers
pi -e ./src/index.ts
```

## What happens during execution
1. Supipowers validates phase + quality preconditions.
2. Router selects backend in this order:
   - `ant_colony` (if available and suitable)
   - `subagent`
   - native fallback
3. Progress signals are shown in status/widget.
4. Run artifacts are written under `.pi/supipowers/runs/<run-id>/`.

## Generated artifacts
- State: `.pi/supipowers/state.json`
- Execution events: `.pi/supipowers/events.jsonl`
- Workflow events: `.pi/supipowers/workflow-events.jsonl`
- Runs: `.pi/supipowers/runs/<run-id>/`
- Final reports: `.pi/supipowers/reports/final-*.md`
- QA runs: `.pi/supipowers/qa-runs/<run-id>/` (matrix, logs, screenshots, findings)
- QA auth profile: `.pi/supipowers/qa/auth/profile.json` (local + gitignored)

## Release quick flow
```text
/sp-release-setup
/sp-release --dry-run
/sp-release
```

Optional overrides:
```text
/sp-release 0.1.1
/sp-release --bump minor
```

Supipowers also generates a release notes draft at:
```text
.pi/supipowers/release-notes/<tag>.md
```
It reuses previous release structure when available, otherwise falls back to a default project template.

## QA quick flow (playwright-cli)
```text
/sp-qa "Checkout flow with logged-in user" --url http://localhost:3000
```

Or load workflow from a file:
```text
/sp-qa @docs/qa-workflow.md --url http://localhost:3000
```

`/sp-qa` builds a QA matrix, asks for confirmation, runs playwright-cli checks, stores screenshots/evidence, and asks you to confirm final APPROVE/REFUSE verdict.
