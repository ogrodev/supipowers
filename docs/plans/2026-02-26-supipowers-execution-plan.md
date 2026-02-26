# Supipowers Execution Plan (Phase-by-Phase)

> Derived from: `docs/plans/2026-02-26-supipowers-master-architecture-and-implementation-plan.md`  
> Goal: Start implementation immediately with concrete tasks, files, commands, and milestones.

---

## 0) Delivery Strategy

- **Execution model:** milestone-driven, vertical slices (always runnable).
- **Branch strategy:** one branch per phase (`feat/m0-foundation`, `feat/m1-workflow-engine`, ...).
- **Definition of done per phase:**
  1. Typecheck passes
  2. Tests pass
  3. Manual smoke test passes in Pi
  4. Docs for new public behavior updated

---

## 1) Baseline Setup (M0)

## 1.1 Create project skeleton

### Files to create
- `package.json`
- `tsconfig.json`
- `.gitignore`
- `README.md`
- `src/index.ts`
- `src/types.ts`
- `src/config.ts`
- `tests/smoke.test.ts`

### Commands
```bash
cd /Users/pedromendes/pi-extensions/supipowers
npm init -y
npm pkg set name="supipowers"
npm pkg set version="0.1.0"
npm pkg set type="module"
npm pkg set private=true
npm pkg set scripts.typecheck="tsc --noEmit"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.test:watch="vitest"
npm pkg set scripts.build="tsc -p tsconfig.json"

npm i -D typescript vitest @types/node
npm i @sinclair/typebox
npm i -D @mariozechner/pi-coding-agent @mariozechner/pi-tui
```

### `package.json` updates (exact keys)
- `keywords`: include `"pi-package"`
- `peerDependencies`:
  - `"@mariozechner/pi-coding-agent": "*"`
  - `"@mariozechner/pi-tui": "*"`
  - `"@sinclair/typebox": "*"`
- `pi`:
  - `"extensions": ["./src/index.ts"]`

### Milestone M0 acceptance
- `npm run typecheck` passes
- `npm test` passes
- `pi -e ./src/index.ts` starts without extension load errors

---

## 2) Workflow Engine MVP (M1)

## 2.1 Implement state machine core

### Files to create
- `src/engine/state-machine.ts`
- `src/engine/transitions.ts`
- `src/engine/checkpoints.ts`
- `src/engine/policies.ts`
- `src/storage/state-store.ts`
- `tests/engine/state-machine.test.ts`
- `tests/engine/transitions.test.ts`

### Tasks
1. Define states:
   - `idle`, `brainstorming`, `design_pending_approval`, `design_approved`, `planning`, `plan_ready`, `executing`, `review_pending`, `ready_to_finish`, `completed`, `blocked`, `aborted`
2. Define transition guard contract:
   - `canTransition(from, to, context) -> {ok, reason?}`
3. Persist state at `.pi/supipowers/state.json`.
4. Add `strictness` policy (`strict`, `balanced`, `advisory`) as pure functions.

### Commands
```bash
npm run typecheck
npm test
```

### Milestone M1 acceptance
- Invalid transitions are blocked with explicit reasons.
- State persists and reloads across extension reloads.

---

## 3) Command Surface + Status UX (M2)

## 3.1 Implement user command loop

### Files to create
- `src/commands/sp-start.ts`
- `src/commands/sp-status.ts`
- `src/commands/sp-approve.ts`
- `src/commands/sp-plan.ts`
- `src/ui/status.ts`
- `src/ui/widget.ts`
- `tests/commands/sp-status.test.ts`

### Files to modify
- `src/index.ts` (register commands + session hooks)
- `src/types.ts` (command/result types)

### Tasks
1. Register commands:
   - `/sp-start`
   - `/sp-status`
   - `/sp-approve`
   - `/sp-plan`
2. Show phase + blocker + next action in footer status.
3. Add widget summary for active workflow.
4. Ensure non-UI mode returns text summaries instead of widget calls.

### Manual smoke commands
```bash
pi -e ./src/index.ts
# inside pi:
/sp-start build login flow with tests
/sp-status
/sp-approve
/sp-plan
/sp-status
```

### Milestone M2 acceptance
- User can advance from `idle` to `plan_ready` using commands only.
- `/sp-status` always reports deterministic current state.

---

## 4) Native Execution Adapter (Standalone First) (M3)

## 4.1 Implement internal executor (no external dependencies)

### Files to create
- `src/adapters/native-adapter.ts`
- `src/adapters/router.ts`
- `src/execution/batch-runner.ts`
- `src/execution/checkpoint-runner.ts`
- `src/tools/sp-orchestrate.ts`
- `tests/adapters/native-adapter.test.ts`
- `tests/execution/batch-runner.test.ts`

### Tasks
1. Implement `sp_orchestrate` tool with actions:
   - `transition`
   - `execute`
   - `stop`
2. Add sequential execution batches with checkpoint callbacks.
3. Emit execution events to history log.
4. Route to native adapter when no external capability is detected.

### Commands
```bash
npm run typecheck
npm test
```

### Milestone M3 acceptance
- Full workflow can execute without `oh-pi` and without `pi-subagents`.
- Execution runs are logged with run IDs.

---

## 5) Capability Detection + `pi-subagents` Adapter (M4)

## 5.1 Add adapter integrations (first external backend)

### Files to create
- `src/adapters/capability-detector.ts`
- `src/adapters/subagent-adapter.ts`
- `src/adapters/normalizers/subagent-result.ts`
- `tests/adapters/capability-detector.test.ts`
- `tests/adapters/subagent-adapter.test.ts`

### Tasks
1. Detect `subagent` tool availability at runtime.
2. Support routed modes:
   - single
   - chain
   - parallel
3. Normalize subagent outputs into Supipowers event model.
4. Persist adapter choice in run summary.

### Manual smoke
```bash
# with pi-subagents installed in pi environment
pi -e ./src/index.ts
/sp-start implement profile page
/sp-plan
/sp-execute
/sp-status
```

### Milestone M4 acceptance
- Router prefers subagent backend when ant colony is unavailable.
- Failures gracefully fallback to native adapter.

---

## 6) Optional `oh-pi` Ant Colony Adapter (M5)

## 6.1 Integrate ant colony backend (optional)

### Files to create
- `src/adapters/ant-colony-adapter.ts`
- `src/adapters/normalizers/ant-colony-signal.ts`
- `tests/adapters/ant-colony-adapter.test.ts`

### Tasks
1. Detect `ant_colony` and `bg_colony_status` tools.
2. Route complex execution requests to ant colony.
3. Ingest progress signals into status/widget lines.
4. On absence or runtime error, fallback to subagent/native.

### Manual smoke
```bash
# with oh-pi installed in pi environment
pi -e ./src/index.ts
/sp-start refactor auth module and update tests
/sp-plan
/sp-execute
/sp-status
```

### Milestone M5 acceptance
- Ant colony works when present; extension remains fully usable when absent.
- No hard dependency failures.

---

## 7) Quality Gates Runtime (M6)

## 7.1 Add TDD/review/verification gates

### Files to create
- `src/quality/tdd-gate.ts`
- `src/quality/review-gate.ts`
- `src/quality/verification-gate.ts`
- `src/runtime/tool-guard.ts`
- `src/runtime/input-interceptor.ts`
- `src/tools/sp-revalidate.ts`
- `tests/quality/tdd-gate.test.ts`
- `tests/quality/review-gate.test.ts`

### Tasks
1. Enforce major checkpoints by strictness profile.
2. Add `sp_revalidate` tool for explicit re-check.
3. Block/allow based on policy and available evidence.
4. Produce actionable remediation messages.

### Commands
```bash
npm run typecheck
npm test
```

### Milestone M6 acceptance
- Missing major gates produce deterministic block/warn behavior by policy.
- `sp_revalidate` returns clear pass/fail report.

---

## 8) Finish Workflow + Reports + Recovery (M7)

## 8.1 Close lifecycle and recovery behaviors

### Files to create
- `src/commands/sp-execute.ts`
- `src/commands/sp-stop.ts`
- `src/commands/sp-finish.ts`
- `src/commands/sp-reset.ts`
- `src/storage/events-log.ts`
- `src/storage/run-history.ts`
- `src/reports/final-report.ts`
- `tests/commands/sp-finish.test.ts`
- `tests/recovery/resume.test.ts`

### Tasks
1. Implement structured finish options (merge/pr/keep/discard semantics as metadata).
2. Generate final run summary markdown.
3. Add recovery paths for blocked/interrupted runs.
4. Ensure `/sp-stop` safely transitions execution states.

### Milestone M7 acceptance
- End-to-end run from `/sp-start` to `/sp-finish` is reproducible and logged.
- Interrupted runs can be resumed or cleanly aborted.

---

## 9) Packaging + Release Readiness (M8)

## 9.1 Ship-ready packaging and docs

### Files to create
- `.npmignore`
- `CHANGELOG.md`
- `LICENSE`
- `docs/quickstart.md`
- `docs/configuration.md`
- `docs/troubleshooting.md`

### Files to modify
- `package.json`
- `README.md`

### Tasks
1. Verify `pi` manifest in `package.json` is production-ready.
2. Add install instructions:
   - `pi install /absolute/path/to/supipowers`
   - (later) `pi install npm:supipowers`
3. Add compatibility matrix (standalone / subagent / oh-pi).
4. Prepare release checklist and semantic version baseline.

### Commands
```bash
npm pack --dry-run
npm test
npm run typecheck
```

### Milestone M8 acceptance
- Package can be installed and loaded by Pi via package mechanism.
- Docs fully cover setup, commands, policies, and fallback behavior.

---

## 10) Milestone Checklist (Single View)

- [x] **M0** Foundation bootstrapped and runnable
- [x] **M1** State machine + persistence
- [x] **M2** Command UX + status/widget
- [x] **M3** Native execution adapter
- [x] **M4** Subagent adapter + fallback
- [x] **M5** Ant colony adapter + fallback
- [x] **M6** Quality gates + revalidation tool
- [x] **M7** Finish workflow + reports + recovery
- [x] **M8** Packaging + docs + release readiness

---

## 11) Immediate Start Commands (today)

```bash
cd /Users/pedromendes/pi-extensions/supipowers
npm init -y
npm i -D typescript vitest @types/node @mariozechner/pi-coding-agent @mariozechner/pi-tui
npm i @sinclair/typebox
mkdir -p src src/engine src/commands src/adapters src/storage src/ui tests/engine tests/commands
```

Then implement **M0** and **M1** before any adapter work.

---

## 12) PR Cadence Recommendation

- PR #1: M0 + M1
- PR #2: M2 + M3
- PR #3: M4
- PR #4: M5
- PR #5: M6
- PR #6: M7 + M8

Conventional commit examples:
- `feat(engine): add workflow state machine with transition guards`
- `feat(adapter): add subagent routing with native fallback`
- `feat(quality): enforce tdd and review gates by strictness profile`
