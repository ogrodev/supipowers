# UltraPlan multi-stage authoring

`/supi:ultraplan` produces a runnable UltraPlan by walking a multi-stage, multi-agent
pipeline that turns a one-line user goal into a fully-decomposed `authored.json` ready for
execution. Most agent work happens in fresh sub-agent sessions so the user's main session
stays small.

## Stages

```
INTAKE → SCOUT → DISCOVER → RESEARCH → SYNTHESIZE → REVIEW (revise×n) → APPROVE
```

| Stage       | Slot              | Purpose                                                                                  | Persists                                                |
|-------------|-------------------|------------------------------------------------------------------------------------------|---------------------------------------------------------|
| Intake      | `intake`          | Extract title, goal, applicable stacks, deferred ideas from a seed prompt                | `authoring/intake.json`                                  |
| Scout       | `scout`           | Repository reconnaissance (reusable assets, conventions, existing tests)                 | `authoring/scout.json`                                   |
| Discover    | `discoverer`      | Capture user decisions on gray areas; defer out-of-scope ideas                           | `authoring/decisions.jsonl`, `authoring/discuss.md`      |
| Research    | `researcher`      | Per-applicable-stack research (libraries, patterns, pitfalls) in parallel                | `authoring/research/<stack>.md`, `SUMMARY.md`            |
| Synthesize  | `planner`         | Build the draft `authored.json` and `manifest.json`                                      | `authoring/drafts/iteration-N/authored.json` (+ planner snapshot) |
| Review      | `structure-checker`, `scope-checker`, `tdd-checker` (parallel) | Three checkers raise findings against the draft | `authoring/drafts/iteration-N/findings.json` |
| Approve     | (no agent)        | Promote the draft to canonical artifacts                                                 | `<session>/authored.json`, `manifest.json`, `index.json`, `authored.md` |

A **revision** loop runs after Review: if the checkers raise findings, the planner is
re-spawned with the consolidated findings to produce iteration N+1. Bounded to 3 attempts
with stall detection.

## Commands

```
/supi:ultraplan                # bare entry: resume picker if any in-flight, else TUI input + start
/supi:ultraplan plan "..."     # start a new pipeline; positional arg is the seed prompt
/supi:ultraplan plan --auto    # run end-to-end without user gates
/supi:ultraplan plan --manual  # gate at every stage
/supi:ultraplan resume [<id>]  # resume an in-flight authoring session
/supi:ultraplan discover       # advance/re-run the discover stage of the active session
/supi:ultraplan research       # advance/re-run the research stage
/supi:ultraplan synthesize     # advance/re-run the synthesize stage
/supi:ultraplan review         # advance/re-run the review stage
/supi:ultraplan approve        # promote an approved draft
/supi:ultraplan quick ["..."]  # legacy single-shot path; deprecated, removed next release
/supi:ultraplan run            # consume an authored session (unchanged)
/supi:ultraplan status         # show pipeline progress for an authoring session
/supi:ultraplan next           # recommend the next session to run
```

By default, the pipeline gates at **discover**, **synthesize**, and **approve**. `--auto`
removes all gates; `--manual` gates after every stage.

## Synthesize stage `$EDITOR` round-trip

After the planner produces `drafts/iteration-1/authored.json`, the synth gate:

1. Renders the JSON to `drafts/iteration-1/authored.md` (YAML frontmatter + structured
   sections per stack/domain/scenario).
2. Opens the markdown in `$VISUAL` or `$EDITOR` (or the OS opener as a fallback).
3. On save, parses the markdown back to JSON and overlays the user's edits onto the
   planner's draft. Non-editable fields (agent slot bindings, proofs) are preserved verbatim.
4. On parse failure, prepends a structured `<!-- AUTHORED EDIT ERRORS -->` annotation block
   to the file and re-opens. Two consecutive failures yield to a manual recovery decision.

For the round-trip to be blocking on save, set `$VISUAL` or `$EDITOR` to a CLI-style
editor (e.g. `code --wait`, `vim`, `nvim`, `nano`). The OS-default opener (`open`,
`xdg-open`, `start`) returns immediately and is a fallback only.

## Per-stack model overrides

The pipeline registers ten action ids in `ModelActionRegistry`:

| Action id                                          | Default role hint |
|----------------------------------------------------|-------------------|
| `ultraplan.authoring.intake`                       | architect         |
| `ultraplan.authoring.scout`                        | research          |
| `ultraplan.authoring.discoverer`                   | architect         |
| `ultraplan.authoring.researcher.frontend`          | research          |
| `ultraplan.authoring.researcher.backend`           | research          |
| `ultraplan.authoring.researcher.infrastructure`    | research          |
| `ultraplan.authoring.planner`                      | architect         |
| `ultraplan.authoring.structure-checker`            | review            |
| `ultraplan.authoring.scope-checker`                | review            |
| `ultraplan.authoring.tdd-checker`                  | review            |

Override any of them in `model.json` (project or global):

```json
{
  "actions": {
    "ultraplan.authoring.planner": { "model": "claude-opus-4-6", "thinkingLevel": "high" },
    "ultraplan.authoring.researcher.backend": { "model": "claude-sonnet-4-5", "thinkingLevel": "medium" }
  }
}
```

Slots not listed inherit `default` → harness role hint → main session, identical to every
other resolver call site.

## Default agents and overrides

Built-in agent prompts live at `src/ultraplan/default-agents/authoring/<slot>.md`. Override
them per-project at `.omp/supipowers/ultraplan-authoring-agents/<slot>.md` or globally at
`~/.omp/supipowers/ultraplan-authoring-agents/<slot>.md`. Frontmatter must include `name`
matching the file slug and `supportedSlots: [<slot>]`.

## File layout

```
~/.omp/supipowers/projects/<slug>/ultraplans/<sessionId>/
  authoring/
    intake.json
    scout.json
    discuss.md                 # rendered from decisions.jsonl
    decisions.jsonl            # one JSON line per decision
    deferred-ideas.md
    research/
      SUMMARY.md
      frontend.md
      backend.md
      infrastructure.md
    drafts/
      iteration-1/
        authored.json          # editable copy
        authored.md            # rendered for editor round-trip
        authored.planner.json  # planner-original snapshot (forensics)
        findings.json
      iteration-2/...
    pipeline-log.jsonl         # append-only event stream
  authored.json                # only after APPROVE
  manifest.json                # canonical
  authored.md                  # canonical render
```

## Cross-session artifact resolution

Scenario proofs are stored as `artifact://<phase>-<attemptId>` references
(`src/ultraplan/runtime/reducer.ts`). As of OMP ≥14.9.5, `agent://`,
`artifact://`, and `memory://` URLs resolve across every active session in
the agent graph, not just the originating session. A tester sub-agent reading
the executor's red-proof artifact, or a downstream reviewer reading a peer's
output, gets the artifact transparently — no manual hand-off needed. The
ultraplan supervisor / worktree split (`src/commands/ultraplan.ts`) relies on
this contract; downgrading below OMP 14.9.5 will break cross-attempt proof
introspection.

## Migration from the legacy single-shot path

The legacy `ultraplan_create` tool is preserved for one release behind
`/supi:ultraplan quick` so existing scripts keep working. It prints a deprecation warning
on every invocation and is removed in the next release. Migrate to the multi-stage pipeline
by removing the `quick` token from any wrapper scripts; the rest of the contract is
identical (the canonical artifacts produced by APPROVE round-trip through `/supi:ultraplan
run` without modification).
