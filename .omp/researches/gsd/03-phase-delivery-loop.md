# 03. Phase Delivery Loop

This doc covers the repeating per-phase lifecycle that GSD uses after project bootstrap.

## Canonical phase sequence

The user guide’s lifecycle diagram and the workflow files line up on this sequence:

1. `/gsd-discuss-phase`
2. optional `/gsd-ui-phase`
3. `/gsd-plan-phase`
4. `/gsd-execute-phase`
5. `/gsd-verify-work`
6. optional `/gsd-ship`

If verification finds gaps, the loop returns to planning/execution rather than pretending the phase is done.

---

## 1. Discuss the phase: `/gsd-discuss-phase N`

Purpose from `workflows/discuss-phase.md`:
- extract implementation decisions that downstream agents need
- clarify gray areas
- avoid re-asking the user later
- prevent scope creep

### Step-by-step

1. Read roadmap phase context
2. Identify ambiguous implementation areas inside the already-approved phase scope
3. Ask the user focused questions about those ambiguities
4. Reject new capabilities as scope creep and defer them instead of folding them into the current phase
5. Write a phase `CONTEXT.md` artifact that locks the user’s decisions

### Why `CONTEXT.md` matters

The workflow explicitly says downstream agents consume it:
- researcher reads it to know what to investigate
- planner reads it to know which decisions are locked

That makes discussion a real contract stage, not just a chat.

---

## 2. Optional UI contract: `/gsd-ui-phase N`

Purpose from `workflows/ui-phase.md`:
- generate a `UI-SPEC.md` for frontend phases
- insert between discuss-phase and plan-phase
- lock design decisions before execution to avoid ad-hoc styling drift

### Step-by-step

1. Initialize phase context
2. Check whether UI phase is enabled in config
3. Validate the target phase exists
4. Check for prerequisite context/research and warn if missing
5. Load any sketch findings from `/gsd-sketch`
6. Spawn `gsd-ui-researcher`
7. Write `UI-SPEC.md`
8. Run `gsd-ui-checker`
9. Iterate through a bounded revision loop if needed

### What `UI-SPEC.md` locks

The workflow calls out decisions such as:
- spacing
- typography
- color
- copywriting
- design system direction

---

## 3. Plan the phase: `/gsd-plan-phase N`

Purpose from `workflows/plan-phase.md`:
- create executable `PLAN.md` files
- orchestrate research, planning, and plan-quality verification
- default flow: Research → Plan → Verify → Done

### Step-by-step

1. **Initialize phase context**
   - load phase paths, state, config, prior artifacts, and feature flags

2. **Validate prerequisites**
   - ensure planning exists, roadmap exists, and the requested phase is valid

3. **Resolve existing phase context**
   - use `CONTEXT.md` if present
   - otherwise planning can continue, but discussion is the intended precursor

4. **Optional technical research**
   - run `gsd-phase-researcher`
   - write phase `RESEARCH.md`

5. **Nyquist validation strategy**
   - if enabled, generate `VALIDATION.md`
   - this maps phase requirements to planned verification, before code is written

6. **Optional pattern discovery**
   - run `gsd-pattern-mapper`
   - write `PATTERNS.md` with likely analog files and existing conventions

7. **Planner pass**
   - run `gsd-planner`
   - create one or more `PLAN.md` files

8. **Plan checker pass**
   - run `gsd-plan-checker`
   - review plan quality and send it back through a bounded revision loop if needed

9. **Coverage gate**
   - ensure requirement IDs assigned to the phase are actually covered by plans

10. **Mark ready to execute**
   - update `STATE.md`

### What phase planning can produce

Depending on configuration and phase type:
- `CONTEXT.md` (from prior discuss step)
- `RESEARCH.md`
- `UI-SPEC.md` (from prior UI step)
- `VALIDATION.md`
- `PATTERNS.md`
- one or more `PLAN.md` files
- updated `STATE.md`

---

## 4. Execute the phase: `/gsd-execute-phase N`

Purpose from `workflows/execute-phase.md`:
- execute all plans in a phase using wave-based parallel execution
- keep the orchestrator lean and delegate actual task work to execution agents

### Step-by-step

1. Read project state and phase execution context
2. Discover incomplete `PLAN.md` files for the phase
3. Analyze dependencies between plans
4. Group plans into dependency waves
5. Within a wave, parallelize only when file overlap and dependency rules say it is safe
6. Spawn `gsd-executor` agents, or fall back to sequential inline execution if the runtime cannot reliably coordinate subagents
7. Handle checkpoints and human-intervention pauses
8. Collect execution outputs and run post-execution verification flow

### What wave-based execution means

The workflow treats plans as parallel only when they are independent enough. If plans modify overlapping files, GSD forces sequential execution to avoid collisions.

### Worktree model

When configured, safe parallel plans run in isolated worktrees instead of the same checkout.

---

## 5. Execute one plan: `execute-plan.md`

This workflow defines what the executor does for a single `PLAN.md`.

### Step-by-step

1. Load phase execution context
2. Identify the next incomplete plan
3. Record start time and inspect the plan structure
4. Choose execution pattern
   - inline for very small plans when below threshold
   - autonomous for plans without checkpoints
   - segmented when checkpoints split the work
5. Execute tasks from the plan
6. Create atomic commits as tasks complete
7. Write `SUMMARY.md`
8. Update project state as needed

### Important execution detail

The workflow is not just “code until done.” It routes differently depending on task count and checkpoint structure.

---

## 6. Verify and review phase completion

After execution, `execute-phase.md` runs more than one gate before the phase is considered complete.

The workflow references:
- advisory code review
- regression checks
- schema drift checks
- a verifier pass using `gsd-verifier`

The main output is `VERIFICATION.md`.

Verifier outcomes called out in the workflow family and user docs are effectively:
- passed
- human needed
- gaps found

If human validation is needed, GSD persists that requirement instead of pretending automated checks are enough.

---

## 7. Manual UAT: `/gsd-verify-work N`

Purpose from `workflows/verify-work.md`:
- validate built features through conversational testing with persistent state
- create `UAT.md` that survives context clearing and feeds future gap planning

### Step-by-step

1. Load phase context and detect whether a UAT session already exists
2. If needed, create or resume a phase `UAT.md`
3. Read phase `SUMMARY.md` outputs to identify user-visible deliverables
4. Present one expected behavior at a time to the user
5. Interpret short user responses as pass/issue signals
6. Record failures and infer severity
7. Persist progress so testing can resume later

### Operating model

The workflow philosophy is: show what should happen, ask whether reality matches.

This is explicitly human-in-the-loop acceptance testing, not just another automated gate.

---

## 8. Gap-closure loop

If verification or UAT finds issues, GSD routes back into planning and execution.

Documented loop:
1. detect gaps in `VERIFICATION.md` or `UAT.md`
2. run `/gsd-plan-phase N --gaps`
3. generate gap-only plans
4. run `/gsd-execute-phase N --gaps-only`
5. verify again

This is one of the clearest signals that GSD is a control loop, not a one-shot prompt.

---

## 9. Ship the phase: `/gsd-ship N`

Purpose from `workflows/ship.md`:
- close the plan → execute → verify → ship loop by creating a PR from completed work

### Step-by-step

1. Load phase state and config
2. Run preflight checks:
   - verification status
   - clean working tree
   - correct branch
   - remote configured
   - `gh` CLI available and authenticated
3. Push the branch
4. Generate a rich PR body from roadmap, summary, and verification artifacts
5. Create the PR

### Shipping expectation

Shipping is artifact-driven too. The PR body is synthesized from the same planning/execution evidence chain, not hand-written from memory.
