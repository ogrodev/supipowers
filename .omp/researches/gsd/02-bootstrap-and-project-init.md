# 02. Bootstrap and Project Init

This doc covers the front of the workflow: codebase mapping for existing projects, then project initialization.

## A. Existing codebases: `/gsd-map-codebase`

For brownfield work, GSD’s own docs recommend mapping the codebase before planning.

### What it does

`get-shit-done/workflows/map-codebase.md` defines a mapper workflow that:

1. Initializes mapping context via `gsd-sdk query init.map-codebase`
2. Checks whether `.planning/codebase/` already exists
3. If maps already exist, asks whether to refresh, update specific docs, or skip
4. Creates `.planning/codebase/`
5. Spawns parallel `gsd-codebase-mapper` agents
6. Produces a split codebase reference set

### Output documents

The workflow explicitly expects these docs:
- `STACK.md`
- `INTEGRATIONS.md`
- `ARCHITECTURE.md`
- `STRUCTURE.md`
- `CONVENTIONS.md`
- `TESTING.md`
- `CONCERNS.md`

### Why it exists

The point is to give later research, planning, and execution a codebase-grounded reference set instead of asking the model to rediscover conventions from scratch every time.

## B. Project initialization: `/gsd-new-project`

`get-shit-done/workflows/new-project.md` defines this as the unified “idea to ready-for-planning” workflow.

### Step-by-step

1. **Setup and environment checks**
   - Loads init context with `gsd-sdk query init.new-project`
   - Detects models, repo state, whether planning already exists, whether the repo is brownfield, whether git exists, and runtime details

2. **Brownfield guard**
   - If the repo has existing code and lacks a codebase map, the docs and workflow steer toward `/gsd-map-codebase`

3. **Deep questioning**
   - In interactive mode, GSD asks detailed product and scope questions
   - The workflow treats this as high leverage because it shapes every downstream artifact

4. **Write `PROJECT.md`**
   - Captures what the project is, what it should do, important constraints, and the current vision

5. **Collect workflow/config preferences**
   - The command reference lists outputs including `config.json`
   - The workflow captures choices that affect later behavior such as planning/execution style and whether docs are committed

6. **Optional project research**
   - The workflow can spawn 4 parallel research agents covering areas like stack, features, architecture, and pitfalls
   - A synthesizer then produces an aggregate summary

7. **Write `REQUIREMENTS.md`**
   - Converts the project definition into structured requirements and scope boundaries

8. **Create `ROADMAP.md`**
   - Spawns `gsd-roadmapper`
   - Breaks the work into phases

9. **Initialize `STATE.md`**
   - Establishes current phase/progress state so later commands can route correctly

### Outputs called out by docs

`docs/COMMANDS.md` explicitly lists these outputs for `/gsd-new-project`:
- `PROJECT.md`
- `REQUIREMENTS.md`
- `ROADMAP.md`
- `STATE.md`
- `config.json`
- `research/`
- `CLAUDE.md`

## C. Optional early exploration before phase planning

The user guide also documents two optional pre-planning tools:

- `/gsd-spike` — technical feasibility exploration
- `/gsd-sketch` — interactive HTML mockups and design exploration

These are not the mainline bootstrap path, but they can feed later phase discussion and UI planning.

## D. End state of bootstrap

After bootstrap, GSD is ready to move phase-by-phase. The essential handoff is:

- project intent is defined
- requirements are enumerated
- phases are sequenced in a roadmap
- persistent state exists under `.planning/`

At that point, the next normal step is phase discussion via `/gsd-discuss-phase`.
