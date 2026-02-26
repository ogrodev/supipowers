<img width="1024" height="434" alt="image" src="https://github.com/user-attachments/assets/53e1c609-1e85-4c0b-873c-3b66e8f736bf" />

# Supipowers

Pi-native workflow framework inspired by the amazing work of [obra/Superpowers](https://github.com/obra/superpowers).

Supipowers turns software delivery into a phase-driven workflow with runtime guardrails, adapter routing, quality gates, and traceable execution artifacts.

## Installation

### Local path (recommended while developing)
```bash
pi install /absolute/path/to/supipowers -l
```

### npm (when published - WIP)
```bash
pi install npm:supipowers
```

### Temporary run without install
```bash
pi -e ./src/index.ts
```

## Core command flow

```text
/sp-start Build feature X with tests
# Supipowers auto-approves + auto-plans, then asks if it should execute now
/sp-execute   # optional resume/retry command
/sp-finish merge --review-pass
```

`/sp-start` now auto-advances workflow phases that were previously manual (`approve` + `plan`). It generates the plan artifact immediately and asks whether to execute right away. Objective is required (inline or prompted interactively); when prompted, Enter reuses the previous objective.

UI defaults to a compact one-line footer view. Use `F6` (fallback: `Alt+V`) to toggle compact/full visualization. View preference is persisted per repo.
Additional commands:
- `/sp-status` — current state, blocker, next action
- `/sp-stop` — stop active execution
- `/sp-view [compact|full|toggle|status]` — set or inspect visualization mode
- `/sp-reset` — reset workflow to idle
- `/sp-release-setup [preset]` — create repo-specific release pipeline config
- `/sp-release [version]` — run configured release automation (auto-detects next version when omitted)
- `/sp-qa [workflow|@file] [--url <target>]` — build QA matrix, run playwright-cli checks, store screenshots/findings, and confirm final approve/refuse verdict
- `/sp-rewind` — interactive rollback to a previous phase (`idle`, `brainstorming`, `planning`, `plan_ready`)

## Tools

- `sp_orchestrate`
  - actions: `transition`, `execute`, `stop`
- `sp_revalidate`
  - re-run quality checks by scope/stage

## Adapter compatibility matrix

| Capability | Route | Notes |
|---|---|---|
| `ant_colony` available | `ant_colony` preferred for larger runs | progress signal ingestion enabled |
| `subagent` available | `subagent` fallback/primary | supports chain/parallel simulation layer |
| neither available | native adapter | always available fallback |

Router fallback order:
1. selected primary adapter
2. remaining adapters in priority (`ant_colony` -> `subagent` -> `native`)

## Configuration

Create `.pi/supipowers/config.json`:

```json
{
  "strictness": "balanced",
  "showWidget": true,
  "showStatus": true
}
```

See full options: `docs/configuration.md`.

## Artifacts

Supipowers writes runtime data under `.pi/supipowers/`:
- `state.json`
- `events.jsonl`
- `workflow-events.jsonl`
- `runs/<run-id>/summary.md`, `details.json`
- `reports/final-*.md`
- `qa-runs/<run-id>/matrix.json`, `execution-log.jsonl`, `screenshots/*`, `findings.md`
- `qa/auth/profile.json` (repo-local reusable auth setup, gitignored)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## Local release command

First configure release pipeline for the current repo:

```text
/sp-release-setup
```

Optional presets:
```text
/sp-release-setup node
/sp-release-setup python
/sp-release-setup rust
/sp-release-setup go
/sp-release-setup generic
```

Then run release automation:

```text
/sp-release
```

By default, Supipowers auto-detects the next version from existing tags/package version and commit history. You can still set one explicitly:

```text
/sp-release 0.1.1
/sp-release --bump minor
```

A release notes draft is generated at `.pi/supipowers/release-notes/<tag>.md`.
- If a previous release is found, Supipowers mirrors its section structure.
- If not, Supipowers generates a project-friendly fallback template.

Useful flags:
- `--dry-run` (validate pipeline only)
- `--bump patch|minor|major`
- `--skip-push`
- `--skip-release`
- `--skip-tests`
- `--allow-dirty`
- `--yes`

## Release checklist (SemVer baseline)

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm pack --dry-run`
- [ ] verify install with `pi install /absolute/path/to/supipowers -l`
- [ ] update `CHANGELOG.md`
- [ ] version bump follows SemVer

## Docs

- Research: `docs/research/2026-02-26-pi-extension-landscape-and-superpowers-revalidation.md`
- Master architecture: `docs/plans/2026-02-26-supipowers-master-architecture-and-implementation-plan.md`
- Execution plan: `docs/plans/2026-02-26-supipowers-execution-plan.md`
- Quickstart: `docs/quickstart.md`
- Configuration: `docs/configuration.md`
- Troubleshooting: `docs/troubleshooting.md`
