# 04. Artifacts and Routing

This doc summarizes the persistent docs GSD uses and how it routes to the next command.

## A. Persistent artifacts by stage

## Project bootstrap artifacts

| Artifact | Role |
|---|---|
| `PROJECT.md` | Project definition, intent, scope framing |
| `REQUIREMENTS.md` | Structured requirement set and scope boundaries |
| `ROADMAP.md` | Phase decomposition of the work |
| `STATE.md` | Current phase/progress/status backbone |
| `config.json` | Workflow behavior and feature toggles |
| `research/` | Project-level research outputs |
| `CLAUDE.md` | Runtime-facing instruction/context artifact listed by command docs |

## Brownfield mapping artifacts

Written under `.planning/codebase/`:
- `STACK.md`
- `INTEGRATIONS.md`
- `ARCHITECTURE.md`
- `STRUCTURE.md`
- `CONVENTIONS.md`
- `TESTING.md`
- `CONCERNS.md`

## Per-phase artifacts

| Artifact | Produced by | Purpose |
|---|---|---|
| `CONTEXT.md` | `/gsd-discuss-phase` | Locks user decisions for downstream agents |
| `UI-SPEC.md` | `/gsd-ui-phase` | Locks frontend/UI decisions before planning and execution |
| `RESEARCH.md` | `/gsd-plan-phase` research step | Records technical findings for the phase |
| `VALIDATION.md` | `/gsd-plan-phase` Nyquist validation step | Maps requirements to verification strategy |
| `PATTERNS.md` | `/gsd-plan-phase` pattern mapper | Captures analogous codebase patterns |
| `PLAN.md` | `/gsd-plan-phase` | Executable task plans for the phase |
| `SUMMARY.md` | `execute-plan.md` / executor | Records what was implemented and delivered |
| `VERIFICATION.md` | post-execution verifier flow | Records automated or structured completion verdicts |
| `UAT.md` | `/gsd-verify-work` | Tracks human acceptance testing and issues |

## B. The main artifact chain

The workflow can be summarized as this artifact pipeline:

`PROJECT.md` → `REQUIREMENTS.md` → `ROADMAP.md` → `CONTEXT.md` / `RESEARCH.md` / `UI-SPEC.md` / `VALIDATION.md` / `PATTERNS.md` → `PLAN.md` → `SUMMARY.md` → `VERIFICATION.md` / `UAT.md`

Key point: later commands are supposed to consume existing artifacts, not regenerate the world from chat history.

## C. Command responsibilities

| Command | Main role |
|---|---|
| `/gsd-map-codebase` | Build codebase reference docs for existing repos |
| `/gsd-new-project` | Initialize project intent, requirements, roadmap, and state |
| `/gsd-discuss-phase` | Lock implementation decisions for a phase |
| `/gsd-ui-phase` | Lock frontend/UI contract for a phase |
| `/gsd-plan-phase` | Convert a roadmap phase into executable plans |
| `/gsd-execute-phase` | Run those plans in dependency waves |
| `/gsd-verify-work` | Run human acceptance testing and persist UAT state |
| `/gsd-ship` | Push branch and create PR from artifacts |
| `/gsd-next` | Inspect state and route to the next logical command |

## D. `/gsd-next` routing logic

`workflows/next.md` defines `/gsd-next` as a state-based router.

### Safety gates first

Before routing, it checks for blockers such as:
- unresolved checkpoint marker (`.planning/.continue-here.md`)
- project error state in `STATE.md`
- unresolved verification failures
- incomplete prior-phase work

Only after those pass does it decide what to do next.

### Typical routing outcomes

The workflow docs and guide imply this progression:

- no `.planning/` project → `/gsd-new-project`
- current phase has no discussion context → `/gsd-discuss-phase`
- context exists but no plans → `/gsd-plan-phase`
- plans exist but execution is incomplete → `/gsd-execute-phase`
- execution summaries exist and work needs user validation → `/gsd-verify-work`
- current milestone finished → milestone-completion commands

So `/gsd-next` is not magic orchestration. It is a state reader over the `.planning/` document set.

## E. Milestone progression

The user guide shows the larger loop after all phases complete:
- `/gsd-audit-milestone`
- `/gsd-complete-milestone`
- optional `/gsd-new-milestone`

That means GSD supports repeated build cycles, not just a single project bootstrap and one implementation pass.

## F. Practical reading order

If you need to understand a live GSD project quickly, the most useful artifact order is:

1. `STATE.md`
2. `ROADMAP.md`
3. `REQUIREMENTS.md`
4. current phase `CONTEXT.md`
5. current phase `PLAN.md`
6. current phase `SUMMARY.md`
7. current phase `VERIFICATION.md` or `UAT.md`

That reading order mirrors the system’s own routing logic.
