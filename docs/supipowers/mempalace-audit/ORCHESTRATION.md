# MemPalace Audit — Orchestration

You are the orchestrator. Your job is to land the five MemPalace audit landing orders in this directory, validate everything end-to-end, and leave the working tree green under `bun ci`.

## Inputs you've been handed

- `docs/supipowers/mempalace-audit/01-quick-wins.md`
- `docs/supipowers/mempalace-audit/02-hooks-gating-cache.md`
- `docs/supipowers/mempalace-audit/03-write-durability.md`
- `docs/supipowers/mempalace-audit/04-search-and-format-polish.md`
- `docs/supipowers/mempalace-audit/05-architectural-batching.md`

Each document lists its scope, required changes, files touched, acceptance criteria, and reviewer checklist. Treat the **Acceptance criteria** and **Reviewer checklist** lists as the contract — those are what you cross-check after implementation.

## Dependency graph

```
#1 (quick wins)
  ├──> #2 (hooks gating + cache)
  ├──> #3 (write durability)
  └──> #4 (search + format polish)
              │
              └──> #5 (batched wake_up+search) ── also needs #2
```

`#1` is the foundation. Every other landing order depends on it.

`#5` depends on both `#1` and `#2` because the batched action must respect the install-gating from #2; if you batch before #2 lands, you reintroduce the unconditional python spawn problem the audit just flagged.

## Phasing

### Phase 1 — Foundation (serial, blocking)

Dispatch **one** `task` agent for `#1`. Do not parallelize this phase.

Why serial: `#1` adds the schema↔python drift test that catches regressions in `#2`/`#3`/`#4`. It also touches `hooks.ts:262, 280, 327, 367` (timeout unit fix) — overlapping with later phases' edits to the same handlers.

```
agent: task
task id: QuickWins
context: see Phase 1 dispatch template below
```

Block on completion. Verify acceptance criteria from `01-quick-wins.md` before moving on. Run `bun test tests/mempalace/` to confirm no regressions.

### Phase 2 — Parallel implementations (parallel, fan-out)

Dispatch **three** `task` agents in a single batch:

- `#2` → hooks gating + cache hygiene
- `#3` → write durability
- `#4` → search heuristics + format polish

All three may touch `hooks.ts`. To avoid merge conflicts:

- **#2 owns** the registration block + `clearAll` handler + cache module-level state.
- **#3 owns** the bridge surface and `session-summary.ts`; `hooks.ts` edits only inside the compaction-checkpoint and shutdown-diary handler bodies.
- **#4 owns** the auto-search promise body inside `before_agent_start` and `pickHits`.

State this section ownership **explicitly** in each task's `context`. Each task must restrict its `hooks.ts` edits to its owned region; if it discovers it needs to edit outside its region, it must DM the other tasks via `irc` and reach agreement before editing.

Run all three with `isolated: true` so they return patches. Apply the patches in order #2 → #3 → #4, running `bun test tests/mempalace/` between each apply. If a later patch conflicts, dispatch a focused fix-up task (see Phase 4) rather than re-running the original.

### Phase 3 — Architectural (serial, after Phase 2)

Dispatch one `task` agent for `#5`. It depends on the gating from #2 and the schema/dispatch shape from #1, both of which are now in place.

Why serial again: `#5` rewires the hottest path in `before_agent_start`, and you want the surface of `hooks.ts` to be quiet before touching it.

### Phase 4 — Cross-check + gap fill (mixed, repeat until clean)

After Phase 3 lands:

1. For each landing order doc, walk its **Acceptance criteria** list. For every item, confirm with a tool call:
   - Code-level claim → `ast_grep` / `read` / `lsp` evidence.
   - Test-level claim → run the specific test file and confirm it passes.
   - Behavior claim → confirm via test output or grep for the call shape.

   Compile a `cross-check.md` artifact (write to `local://mempalace-audit-cross-check.md`) listing each criterion and either `[OK]` with evidence or `[GAP]` with the missing piece.

2. For every `[GAP]`, dispatch a focused `task` agent. Give it the gap line verbatim, the file paths it should look at, and the acceptance criterion it must satisfy. Do **not** rewrite the scope — just fill the gap.

3. Repeat (1)–(2) until `cross-check.md` has zero `[GAP]`s.

### Phase 5 — Full CI

Run `bun ci` once the cross-check is clean. If it fails:

- Categorize each failure by which landing order's contract it violates.
- Dispatch one fix-up task per failure category. Pass it the failing output and the relevant doc.
- Re-run `bun ci`. Loop until green.

Then run `bun test tests/mempalace/` once more as a sanity check. Then yield.

## Dispatch templates

When you call the `task` tool, follow this skeleton. Adjust per landing order.

### Phase 1 (single task)

```
proxy_task({
  agent: "task",
  isolated: false,
  context: """
  # Goal
  Implement Landing Order #1 (Quick Wins) for the MemPalace audit.

  # Constraints
  - Read docs/supipowers/mempalace-audit/01-quick-wins.md completely before editing anything.
  - Satisfy every item in its Acceptance criteria and Reviewer checklist.
  - Do NOT run `bun ci`. Do NOT run formatters. Do NOT touch files outside the doc's "Files in scope" list.
  - Do NOT yield until every Acceptance criterion is provably met by code + tests in the repo.

  # Contract
  Files in scope:
  - src/mempalace/schema.ts
  - src/mempalace/runtime.ts
  - src/mempalace/hooks.ts (only the 4 timeout-passing call sites)
  - src/mempalace/python/mempalace_bridge.py
  - tests/mempalace/schema.test.ts (new table-driven test)
  - tests/mempalace/runtime.test.ts
  - tests/mempalace/hooks.test.ts
  """,
  tasks: [{
    id: "QuickWins",
    description: "MemPalace audit #1",
    assignment: """
    # Target
    Land everything specified in docs/supipowers/mempalace-audit/01-quick-wins.md.

    # Change
    Follow the doc's "Required changes" section item by item. Each numbered subsection is a discrete edit.

    # Acceptance
    Every box in the doc's "Acceptance criteria" list must be checkable. Run `bun test tests/mempalace/` locally to confirm the new tests pass and no existing tests regress. Do not run `bun ci` or formatters.
    """
  }]
})
```

### Phase 2 (three parallel tasks)

```
proxy_task({
  agent: "task",
  isolated: true,
  context: """
  # Goal
  Land Landing Orders #2, #3, #4 of the MemPalace audit in parallel.

  # Constraints
  - Each task reads its own doc end-to-end before editing.
  - Section ownership in src/mempalace/hooks.ts:
    - #2 owns: registration block (top of registerMempalaceHooks), clearAll handler, cache module-level state.
    - #3 owns: compaction-checkpoint handler body, shutdown-diary handler body.
    - #4 owns: the auto-search promise inside before_agent_start, pickHits, and prompt-classification helpers.
  - If you need to edit outside your owned region, DM the other tasks via irc and resolve before editing.
  - Do NOT run `bun ci`. Do NOT run formatters. Do NOT touch files outside your doc's Files-in-scope list.

  # Contract
  Each task's contract is its own landing-order doc.
  """,
  tasks: [
    { id: "HooksGating",      description: "MemPalace audit #2", assignment: "Land docs/supipowers/mempalace-audit/02-hooks-gating-cache.md ..." },
    { id: "WriteDurability",  description: "MemPalace audit #3", assignment: "Land docs/supipowers/mempalace-audit/03-write-durability.md ..." },
    { id: "SearchPolish",     description: "MemPalace audit #4", assignment: "Land docs/supipowers/mempalace-audit/04-search-and-format-polish.md ..." }
  ]
})
```

### Phase 3 (single task)

Same shape as Phase 1, pointed at `05-architectural-batching.md`.

### Phase 4 gap-fill tasks

```
proxy_task({
  agent: "quick_task",
  tasks: [{
    id: "GapFix_<criterion-slug>",
    description: "Fix gap in audit #<n>",
    assignment: """
    Acceptance criterion not yet met:
      <verbatim criterion line>
    Doc reference: docs/supipowers/mempalace-audit/0<n>-<name>.md
    File(s) to inspect: <paths>

    Implement the smallest change that satisfies the criterion. Add a test if the doc requires one and it is missing. Do not expand scope.
    """
  }]
})
```

## Cross-check procedure (Phase 4 detail)

For each landing order, walk its **Acceptance criteria** list. For each line:

1. Re-read the relevant file(s) at the line range that should reflect the change.
2. If the criterion is "test passes": run `bun test <file>` and grep the output for the new test name.
3. If the criterion is "no regression": run `bun test tests/mempalace/` and confirm zero failures.
4. Record the criterion in `local://mempalace-audit-cross-check.md` with status `[OK]` (with the evidence path/line) or `[GAP]` (with the missing piece).

Cross-check is **not** optional. The user has explicitly asked for it. Do not skip even when "it looks right."

## Final reporting

Once `bun ci` is green and `cross-check.md` shows zero gaps, write a final summary to `local://mempalace-audit-summary.md` containing:

- One paragraph per landing order: what landed, key files touched, tests added.
- Total green/red counts from final `bun ci`.
- Any decisions you made when the docs left a choice open (e.g. Option 1 vs Option 2 in #3.1).
- Any deferred follow-ups (things the docs flagged as out-of-scope but a sub-agent surfaced as worth tracking).

Then yield with a one-paragraph status pointing at `cross-check.md` and `summary.md`.

## Hard rules

- **MUST NOT** run formatters or `bun ci` inside sub-agents. The orchestrator runs `bun ci` exactly once at the end across the union of all changes.
- **MUST NOT** declare a landing order complete on the strength of a subagent's word alone. The cross-check is the source of truth.
- **MUST NOT** expand scope. If a sub-agent surfaces additional findings, capture them in `summary.md`'s deferred section; do not implement them.
- **MUST NOT** yield while a `[GAP]` is open in `cross-check.md` or `bun ci` is red.
- **MUST** preserve existing public surface: no renamed exports, no removed config fields, no schema-breaking changes outside what the docs explicitly approve.
- **MUST** keep section ownership in `hooks.ts` enforced during Phase 2 to avoid wasted re-work.

## Failure modes to watch for

- **Sub-agent rewrites unrelated code.** Cross-check will catch it via diff inspection — abort that sub-agent's patch, dispatch a fresh focused task.
- **Sub-agent silently relaxes a test instead of making the code right.** Cross-check by inspecting the diff for the test file: any test deletion or assertion weakening must be explicitly justified in the doc; otherwise reject and re-dispatch.
- **Two sub-agents both add the same import or helper.** Merge by hand during patch application; do not let either patch win silently.
- **`bun ci` fails on something unrelated to the audit.** Confirm with `git status`/`git log`; if the failure is pre-existing, fix it as a separate task and note it in `summary.md` — do not roll back audit work.
