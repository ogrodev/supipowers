# Supipowers

Pi-native workflow framework inspired by Superpowers.

Supipowers turns software delivery into a phase-driven workflow with runtime guardrails, adapter routing, quality gates, and traceable execution artifacts.

## Installation

### Local path (recommended while developing)
```bash
pi install /absolute/path/to/supipowers -l
```

### npm (when published)
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
/sp-approve
/sp-plan
/sp-execute
/sp-finish merge --review-pass
```

Additional commands:
- `/sp-status` — current state, blocker, next action
- `/sp-stop` — stop active execution
- `/sp-reset` — reset workflow to idle

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

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

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
