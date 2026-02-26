# Supipowers Master Architecture & Implementation Plan

> **Related research:** `docs/research/2026-02-26-pi-extension-landscape-and-superpowers-revalidation.md`

## Goal

Build the definitive Pi extension for reliable software delivery workflows:
- preserves Superpowers methodology,
- becomes Pi-native in runtime behavior,
- integrates optionally with ecosystem leaders (`oh-pi`, `pi-subagents`),
- and remains fully functional standalone.

---

## 1) Product End-State (What “Done” Means)

At end-state, Supipowers provides:
1. A **workflow runtime** (not only static instructions)
2. A **phase-aware execution model** from idea to merge/discard
3. **Configurable quality gates** (strict / balanced / advisory)
4. **Execution backends** with auto-fallback
5. **Clear UX surface** (commands, status, overlays, reports)
6. **Operational traceability** (state, events, run history)
7. **Robust packaging** and compatibility behavior

---

## 2) Product Principles

1. **Framework over hacks**: enforce process consistency.
2. **Strict core, configurable ergonomics**: users can tune strictness, not lose safety fundamentals.
3. **No hard external dependency**: integrations are optional adapters.
4. **Evidence-based completion**: tests, verification, and review signals matter.
5. **Transparent operation**: users always know phase, blockers, and next action.

---

## 3) Scope

## In Scope
- Workflow orchestration (brainstorm → design approval → plan → execute → review → finish)
- Guardrails for planning/TDD/review discipline
- Capability detection + adapter routing (oh-pi/subagents/native)
- Command + tool + widget UX
- Persistence and run observability

## Out of Scope (initially)
- Full replacement of external colony engines
- Heavy custom code editor UI
- Cloud backend dependency

---

## 4) High-Level Architecture

## 4.1 Layered design

1. **Interface Layer**
   - Slash commands (`/sp-*`)
   - Registered tool(s) for orchestration
   - Widgets/status/footer messages

2. **Workflow Engine Layer**
   - State machine + transition rules
   - Gate checks (design approved, plan exists, etc.)
   - Strictness policies

3. **Execution Layer**
   - Adapter router
   - `oh-pi ant_colony` adapter
   - `pi-subagents` adapter
   - native sequential fallback adapter

4. **Quality Layer**
   - TDD gate model
   - review gate model
   - verification-before-completion checks

5. **Persistence & Telemetry Layer**
   - session-scoped workflow state
   - event log and run history
   - optional diagnostics snapshot

6. **Integration Layer**
   - extension/tool discovery
   - capability map
   - compatibility shim behavior

---

## 4.2 Core modules (proposed)

```text
src/
  index.ts                      # extension bootstrap
  config.ts                     # settings load/merge/defaults
  commands/
    sp-start.ts
    sp-status.ts
    sp-approve.ts
    sp-plan.ts
    sp-execute.ts
    sp-stop.ts
    sp-finish.ts
  engine/
    state-machine.ts            # workflow state + transitions
    policies.ts                 # strictness profiles
    checkpoints.ts              # gate validation
  adapters/
    capability-detector.ts
    ant-colony-adapter.ts       # oh-pi integration
    subagent-adapter.ts         # pi-subagents integration
    native-adapter.ts           # standalone fallback
    router.ts
  quality/
    tdd-gate.ts
    review-gate.ts
    verification-gate.ts
  runtime/
    input-interceptor.ts
    tool-guard.ts
    context-injector.ts
  ui/
    status.ts
    widget.ts
    overlays.ts
  storage/
    state-store.ts
    events-log.ts
    run-history.ts
  schemas/
    tool-schemas.ts
    config-schema.ts
```

---

## 5) Workflow State Machine Schema

## 5.1 States
- `idle`
- `brainstorming`
- `design_pending_approval`
- `design_approved`
- `planning`
- `plan_ready`
- `executing`
- `review_pending`
- `ready_to_finish`
- `completed`
- `blocked`
- `aborted`

## 5.2 Required transition guards

| Transition | Guard |
|---|---|
| `idle -> brainstorming` | user goal captured |
| `brainstorming -> design_pending_approval` | draft design artifact exists |
| `design_pending_approval -> design_approved` | explicit user approval signal |
| `design_approved -> planning` | design artifact accepted |
| `planning -> plan_ready` | implementation plan artifact created |
| `plan_ready -> executing` | execution backend resolved |
| `executing -> review_pending` | execution batch complete |
| `review_pending -> ready_to_finish` | review checks pass |
| `ready_to_finish -> completed` | finish action selected and validated |

If guards fail, state moves to `blocked` with reason.

---

## 6) Feature Schema (End-State Matrix)

## 6.1 Core capabilities

| ID | Capability | Priority | End-State Definition |
|---|---|---|---|
| F01 | Workflow runtime | Must | System tracks and enforces workflow phases |
| F02 | Design approval checkpoint | Must | Implementation cannot start without explicit approval (unless override policy) |
| F03 | Plan artifact enforcement | Must | Execution requires a plan artifact reference |
| F04 | Execution adapter router | Must | Auto-selects colony/subagent/native backend |
| F05 | TDD quality gate | Must | Marks execution non-complete if TDD gate fails |
| F06 | Review gate | Must | Requires spec+quality review checkpoint |
| F07 | Finish workflow | Must | Structured end options: merge/pr/keep/discard |
| F08 | Command UX surface | Must | `/sp-*` command family implemented |
| F09 | Status + widget | Must | Real-time phase/progress visibility |
| F10 | Persistence | Must | Session-resumable workflow state |
| F11 | Event log/history | Must | Actionable diagnostics for what happened |
| F12 | oh-pi optional adapter | Should | Use ant_colony when available |
| F13 | pi-subagents optional adapter | Should | Use subagent chain/parallel when available |
| F14 | Strictness profiles | Should | `strict`, `balanced`, `advisory` modes |
| F15 | Recovery flows | Should | Resume/retry/replan from blocked state |
| F16 | Batch policy controls | Should | configure task batch size and checkpoints |
| F17 | Cost/time budget controls | Could | soft/hard budget constraints for autonomous backends |
| F18 | Metrics dashboard overlay | Could | richer historical operational analytics |

---

## 6.2 UX command schema

| Command | Purpose |
|---|---|
| `/sp-start` | initialize workflow for current objective |
| `/sp-status` | show current phase, backend, blockers, next step |
| `/sp-approve` | approve current design or phase gate |
| `/sp-plan` | generate/store/attach implementation plan |
| `/sp-execute` | trigger execution via selected adapter |
| `/sp-stop` | stop active execution run |
| `/sp-finish` | close branch/workflow with structured options |
| `/sp-reset` | reset workflow state (with confirmation) |

---

## 6.3 Tool schema (minimum)

| Tool | Purpose |
|---|---|
| `sp_orchestrate` | Core orchestration interface for state transitions and routed execution |
| `sp_status` | Programmatic status snapshot for agent + user responses |
| `sp_revalidate` | Re-run quality/review/checkpoint validation against current state |

---

## 7) Adapter Strategy (Optional Integrations)

## 7.1 Capability detection

On session start and before execution:
- detect command/tool presence
- detect known extension fingerprints
- build capability map

Example capability map:

```json
{
  "antColony": true,
  "subagent": true,
  "nativeSequential": true
}
```

## 7.2 Router policy

Default preference:
1. ant colony (if available and task complexity warrants)
2. subagent chain/parallel
3. native sequential executor

Complexity heuristic input:
- expected file breadth
- independent task count
- requested autonomy level
- strictness profile

---

## 8) Guardrail Model

## 8.1 Policy profiles

| Profile | Behavior |
|---|---|
| `strict` | hard blocks on missing gates |
| `balanced` | blocks only on major gates, warns on others |
| `advisory` | no hard block, strong warnings and reminders |

## 8.2 Guardrail checkpoints

- design approval required
- plan required before execute
- test evidence required before completion
- review checkpoint required before finish

---

## 9) Persistence & Observability Schema

## 9.1 Files (proposed)

```text
.pi/supipowers/
  state.json                 # current workflow state
  events.jsonl               # append-only event log
  runs/
    <run-id>/
      summary.md
      adapter-output.json
      quality-report.json
```

## 9.2 Event model (minimum)

```json
{
  "ts": 1760000000000,
  "type": "state_transition",
  "from": "planning",
  "to": "plan_ready",
  "meta": {"planPath":"docs/plans/..."}
}
```

Event types:
- `state_transition`
- `guard_blocked`
- `adapter_selected`
- `execution_started`
- `execution_progress`
- `execution_completed`
- `review_failed`
- `review_passed`
- `workflow_finished`

---

## 10) Configuration Schema (proposed)

```json
{
  "supipowers": {
    "strictness": "balanced",
    "adapterOrder": ["antColony", "subagent", "native"],
    "allowExecutionWithoutPlan": false,
    "allowFinishWithoutReview": false,
    "defaultBatchSize": 3,
    "maxParallel": 4,
    "budgets": {
      "maxCostUsd": null,
      "maxMinutes": null
    },
    "ui": {
      "showWidget": true,
      "showStatus": true
    }
  }
}
```

---

## 11) Implementation Roadmap (Architect-Level)

## Phase 0 — Foundation & Contracts
**Deliverables**
- repo skeleton
- config + schema validation
- basic command registration
- state store scaffold

**Exit criteria**
- extension loads cleanly
- `/sp-status` returns deterministic output

## Phase 1 — Workflow Engine MVP
**Deliverables**
- state machine and transitions
- gate checks for design/plan
- event emission

**Exit criteria**
- invalid transitions blocked with explicit reasons

## Phase 2 — Command UX and User Loop
**Deliverables**
- `/sp-start`, `/sp-approve`, `/sp-plan`, `/sp-status`
- minimal widget/status rendering

**Exit criteria**
- user can progress from goal -> approved design -> plan-ready

## Phase 3 — Native Executor (fallback first)
**Deliverables**
- standalone sequential execution adapter
- batch/checkpoint execution primitives

**Exit criteria**
- full workflow operates without any external extension

## Phase 4 — `pi-subagents` Adapter
**Deliverables**
- capability detector for `subagent`
- chain/parallel mapping
- result normalization into Supipowers events

**Exit criteria**
- routed execution works and persists reports

## Phase 5 — `oh-pi` Ant Colony Adapter
**Deliverables**
- detection for `ant_colony` and `bg_colony_status`
- async signal normalization
- status integration

**Exit criteria**
- background colony can be orchestrated through Supipowers

## Phase 6 — Quality Gate Runtime
**Deliverables**
- tdd/review/verification gate evaluators
- strictness profile behavior

**Exit criteria**
- completion blocked/warned according to profile and missing evidence

## Phase 7 — Finish Workflow & Lifecycle Closure
**Deliverables**
- `/sp-finish` structured decision flow
- final report generation

**Exit criteria**
- workflow completion path is reproducible and auditable

## Phase 8 — Reliability Hardening
**Deliverables**
- retry/recovery from blocked states
- robust error handling
- compatibility and non-interactive behavior checks

**Exit criteria**
- degraded modes behave predictably; no dead-end states

## Phase 9 — Packaging, Docs, and Launch
**Deliverables**
- npm package metadata + pi package declarations
- install docs and quickstart
- release checklist and changelog standards

**Exit criteria**
- one-command install experience with validated docs

---

## 12) Validation & Testing Strategy

## 12.1 Test layers
1. Unit tests: state machine, router, gates
2. Integration tests: adapters with mocked tool responses
3. E2E tests: command-driven full workflow scenarios
4. Compatibility tests: with and without external adapters present

## 12.2 Critical scenarios
- no external adapters available
- subagent only available
- ant colony only available
- both available
- transition/gate failure and recovery
- interrupted execution + resume

---

## 13) Success Metrics

## Adoption
- install growth over time
- active usage of `/sp-*` commands

## Quality
- % workflows completed without manual recovery
- % runs reaching finish with all gates satisfied
- reduction in “implementation without approved plan” events

## Reliability
- adapter fallback success rate
- state recovery success rate after interruption

---

## 14) Risk Register & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Overly rigid UX | adoption drop | strictness profiles + clear override mechanisms |
| External adapter contract drift | execution failures | version-aware detection + defensive normalization |
| Feature overload early | delayed core value | phase roadmap with strict scope gates |
| hidden execution state confusion | user mistrust | always-on status and explicit events/logs |

---

## 15) Definition of Done (Program-Level)

Supipowers is considered “architecturally complete” when:
1. full workflow lifecycle is executable end-to-end,
2. quality gates are enforceable and configurable,
3. optional adapters are integrated with graceful fallback,
4. state and event observability are durable,
5. package/documentation experience is production-ready.

---

## 16) Immediate Next Actions

1. Create extension scaffold (`src/index.ts`, config, state store).
2. Implement workflow state machine and `/sp-status` first.
3. Implement native fallback executor before external adapters.
4. Add adapter detection/router contracts.
5. Add first integration adapter (`pi-subagents`), then `oh-pi`.

---

## 17) Final Architecture Intent

Supipowers should become the **default serious workflow layer** for Pi users:  
high trust, high autonomy, high reliability, and ecosystem-friendly by design.
