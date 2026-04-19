# 01. System Model

## What GSD is

Per `docs/ARCHITECTURE.md`, GSD is a meta-prompting and spec-driven development layer that sits between the user and the coding agent runtime. Its job is to keep work structured as context resets happen, instead of letting the entire project live inside one long, decaying chat.

## Architectural layers

The repo documents a layered model:

1. User invokes a command such as `/gsd-plan-phase 3`
2. Command layer loads a workflow prompt from `commands/gsd/*.md`
3. Workflow layer executes orchestration logic from `get-shit-done/workflows/*.md`
4. Workflow spawns specialized subagents with fresh context
5. `gsd-sdk query ...` helpers provide state/config/path lookups
6. The file system under `.planning/` holds the persistent project memory

In practice, the workflow files are the real orchestrators. They read artifacts, decide what subagents to run, enforce gates, and write back the next-state docs.

## Core design principles visible in the repo

### 1. Persistent state beats chat memory

The repo repeatedly routes through `.planning/` instead of trusting conversational continuity. The architecture docs call this persistent project memory.

### 2. Thin orchestrator, specialized agents

Workflow files stay relatively lean and delegate domain work to named agents such as:
- `gsd-project-researcher`
- `gsd-roadmapper`
- `gsd-phase-researcher`
- `gsd-planner`
- `gsd-plan-checker`
- `gsd-executor`
- `gsd-verifier`
- `gsd-ui-researcher`
- `gsd-ui-checker`

The orchestrator is supposed to coordinate, not do all thinking inline.

### 3. Spec-driven pipeline

The intended progression is not “ask AI to code.” It is:
- define project intent
- convert it into requirements
- phase it in a roadmap
- lock implementation decisions for a phase
- plan executable work
- execute it
- verify it
- ship it

### 4. Fresh-context subagents

Several workflow docs explicitly justify fresh-context agents to reduce context contamination and improve focus. `map-codebase.md` is especially explicit about this.

## Why `.planning/` matters

The system’s state backbone lives in `.planning/`. Common top-level artifacts referenced in docs and workflow files:

- `PROJECT.md`
- `REQUIREMENTS.md`
- `ROADMAP.md`
- `STATE.md`
- `config.json`
- `research/`
- `phases/`
- optionally `codebase/`

Every later stage reads from this backbone instead of re-deriving intent from chat.

## The recurring unit of work

The durable unit is the roadmap phase.

For each phase, GSD generally creates or updates:
- discussion context
- optional UI spec
- optional research and validation docs
- one or more executable plans
- execution summaries
- verification/UAT output

That means GSD is not a single linear run; it is a repeating per-phase control loop built on persistent docs.

## High-level lifecycle

The repo’s documented lifecycle is:

1. Bootstrap the project
2. Build the roadmap
3. For each phase: discuss → optional UI contract → plan → execute → verify → optional ship
4. Complete the milestone
5. Start another milestone if needed

`/gsd-next` exists to infer where in that lifecycle the project currently is by reading `.planning/`.
