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
/sp-approve
/sp-plan
/sp-execute
/sp-finish merge --review-pass
```

`/sp-start` transitions state and automatically kicks off guided brainstorming in chat.

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

## Release quick flow
```text
/sp-release-setup
/sp-release 0.1.1 --dry-run
/sp-release 0.1.1
```
