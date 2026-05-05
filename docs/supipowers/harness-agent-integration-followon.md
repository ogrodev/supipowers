# Follow-on: Per-stage agent-session integration for `/supi:harness`

**Status:** Deferred from initial harness landing (2026-05-04). All scaffolding is in place; this doc captures the remaining work so the next session can execute without re-deriving context.

**Estimated scope:** ~300–500 LOC + tests. One dedicated session.

---

## 1. Goal

Replace the deterministic-only stage runners with hybrid runners that:

1. Build the artifact deterministically (current behavior — keep as fallback / fast path).
2. **Spawn a fresh `platform.createAgentSession` per stage** with the per-stage agent prompt from `src/harness/default-agents/*.md`.
3. Let the agent **augment** the deterministic artifact (Discover) or **author** the stage output (Research) via the `harness_*` tools.
4. Validate the persisted artifact and surface failures structured as `HarnessStageRunResult`.

This is what mirrors `src/ultraplan/authoring/stage-runner.ts` properly. Without it, Discover's `frameworks`/`commitConventions`/`notes` stay sparse, Research stubs never become real writeups, and Design's spec composition is fully manual through the command handler.

---

## 2. What's already in place

You do **not** need to re-do these:

| Asset | Location | Purpose |
|---|---|---|
| Per-stage system prompts | `src/harness/default-agents/{discover,research,design,plan,implement,validate}.md` | YAML-frontmatter + body; loaded via `import … with { type: "text" }` |
| Model action IDs | `src/harness/model.ts` | `harness.{discover,design,plan,implement,validate,gc.fix,review.architecture}` registered at module load; `getHarnessResearchActionId(slug)` registers research per-topic lazily |
| Tools the agents call | `src/harness/tools.ts` | `harness_discover_record`, `harness_research_record`, `harness_decision_record`, `harness_design_spec_persist`, `harness_validate_finding`, `harness_slop_queue_append`, `harness_slop_queue_resolve` |
| Storage layer | `src/harness/storage.ts` | Atomic write helpers + every load/save the agents need indirectly via tools |
| Stage runner shape | `src/harness/stage-runner.ts` | `HarnessStageRunner` interface + `HarnessStageRunnerContext` |
| Deterministic stage runners (fallback) | `src/harness/stages/*.ts` | Already implement `HarnessStageRunner`; they will become the fallback path |
| Pipeline driver | `src/harness/pipeline.ts` | `runHarnessPipelineUntilGate` — already drives stage-by-stage |

The piece that's missing is the **agent-session orchestration glue** between the stage runners and the platform's `createAgentSession`.

---

## 3. Reference implementation to mirror

`src/ultraplan/authoring/stage-runner.ts` + `src/ultraplan/authoring/agent-catalog.ts` + how individual ultraplan authoring stages spawn agents.

Read these in full before starting:

- `src/ultraplan/authoring/stage-runner.ts` — base stage shape ultraplan uses; ours mirrors it.
- `src/ultraplan/authoring/intake-stage.ts` (and its siblings) — concrete pattern for: build assignment prompt → `platform.createAgentSession` → `await session.prompt(...)` → `session.dispose()` → validate artifact persisted.
- `src/ultraplan/authoring/agent-catalog.ts` — slot-binding resolution (built-in / global / project precedence) for the per-stage system prompt overrides.
- `src/ultraplan/authoring/model.ts` — `resolveAuthoringSlotModel` pattern; ours has `resolveHarnessModel` already.

The harness orchestration must replicate **exactly** the cancellation, dispose, and timeout semantics from ultraplan — those are the parts most likely to leak agent sessions if reimplemented.

---

## 4. Required deliverables

### 4.1 Agent-session orchestration helper

**File:** `src/harness/agent-runner.ts` (new)

Single async function:

```ts
export async function runHarnessAgentStage(input: {
  ctx: HarnessStageRunnerContext;
  stage: HarnessStage;
  topicSlug?: string;          // research only
  systemPrompt: string;        // loaded from default-agents/<stage>.md
  assignmentPrompt: string;    // built per-stage from inputs on disk
  expectedTools: readonly string[]; // e.g. ["harness_research_record"] — used for forensics
  timeoutMs?: number;          // default 240_000
}): Promise<{ ok: true; details: Record<string, unknown> } | { ok: false; reason: string }>;
```

Responsibilities:

1. Resolve the model via `resolveHarnessModel(stage, ctx.modelConfig, modelRegistry, platform)` (or `resolveHarnessResearchModel(topicSlug, ...)` for research).
2. Build the `agentDisplayName` via `buildHarnessAgentDisplayName(stage, topicSlug)`.
3. Call `ctx.platform.createAgentSession({ cwd, agentDisplayName, agentId, model, thinkingLevel, systemPromptOverride: systemPrompt })`.
4. `await session.prompt(assignmentPrompt)` with the timeoutMs.
5. Dispose **always** (try/finally).
6. Return `{ok}` based on whether the prompt resolved without throw + the expected artifact landed on disk.

Tests live at `tests/harness/agent-runner.test.ts` with a mocked platform that fakes `createAgentSession` returning a controllable promise. Assert dispose-on-throw, dispose-on-success, timeout path, and model resolution dispatch.

### 4.2 Hybrid stage runners

For each stage, refactor the current deterministic class into a hybrid class with this shape:

```ts
export class HarnessDiscoverStage implements HarnessStageRunner {
  readonly stage = "discover" as const;
  constructor(private readonly opts: { mode: "deterministic" | "agent" } = { mode: "deterministic" }) {}
  // ...
  async run(ctx) {
    if (this.opts.mode === "deterministic") return this.runDeterministic(ctx);
    return this.runWithAgent(ctx);
  }
}
```

`runDeterministic` is the existing code (rename, no behavior change). `runWithAgent`:

1. Calls `runDeterministic` first to produce a baseline artifact.
2. Loads the system prompt from `import discoverPrompt from "../default-agents/discover.md" with { type: "text" }`.
3. Builds an assignment prompt that explicitly references the baseline artifact path on disk.
4. Calls `runHarnessAgentStage(...)`.
5. Re-loads the artifact; verifies the agent didn't corrupt invariants.

Per-stage assignment prompt builders go in `src/harness/stages/<stage>.ts` next to the runner — keep them colocated. Build them deterministically (no LLM) so tests can assert exact bytes.

### 4.3 Research fan-out

Research is the only stage that spawns ≥2 sessions in parallel. Reuse the topic plan from `buildResearchTopicPlan` and spawn N parallel agents (cap at 8 per the plan §7 "Multi-language Research fan-out explodes" mitigation).

Add a `Promise.allSettled` fan-out inside `HarnessResearchStage.runWithAgent`. Each settled rejection becomes a per-topic warning in the stage result; the stage as a whole succeeds when ≥2 of N topics produced valid writeups (the rest land in `[blocked]` per-topic notes).

Cancellation: the outer stage signal must cancel every still-running topic session. Reuse the AbortSignal from `ctx` (currently absent — add `signal?: AbortSignal` to `HarnessStageRunnerContext`).

### 4.4 Pipeline driver wiring

`src/harness/pipeline.ts` `buildHarnessRunner` already takes `BuildRunnerInput`. Extend the input shape with:

```ts
mode?: "deterministic" | "agent"; // default "deterministic" for v1, flip per-stage
```

Don't make `"agent"` the default until #3 ships and tests cover it. The `/supi:harness` command will pass `mode: "agent"` explicitly.

### 4.5 Command-handler integration

`src/harness/command.ts` per-stage subcommands (the redirect-stub ones — `discover`/`research`/`design`/`plan-draft`/`implement`/`validate`/`resume`) need to:

1. Construct or resume the harness session (`loadHarnessSession` / generate a new id via `newHarnessSessionId`).
2. Build `BuildRunnerInput` for the stage by loading prior artifacts from disk.
3. Call `runHarnessPipelineUntilGate` with `startStage: <stage>`.
4. Render the stage outcome via `notifyInfo` / `notifyError`.

This is where follow-on items #1 and #2 from the original deferral list live. **Do them before #3.** Per-stage subcommands without agent integration still produce useful deterministic stubs; per-stage subcommands with agent integration is the real shipping target.

---

## 5. Test plan

| Test file | Coverage |
|---|---|
| `tests/harness/agent-runner.test.ts` | Mocked `platform.createAgentSession`: dispose on success, dispose on throw, timeout returns structured failure, model resolution dispatches the right action id |
| `tests/harness/stages/discover-agent.test.ts` | `runWithAgent` calls deterministic first then agent; baseline artifact preserved when agent throws; agent's tool calls land in discover.json |
| `tests/harness/stages/research-agent.test.ts` | Fan-out spawns N sessions; partial failure (1/3 topics fails) returns warning not blocker; signal cancellation propagates |
| `tests/harness/stages/design-agent.test.ts` | Agent receives discover + every research/<topic>.md in its assignment prompt; spec validator runs after persist |
| `tests/harness/pipeline-agent.test.ts` | End-to-end with `mode: "agent"`: stages fire in order, each spawns exactly one session (Research excepted) |
| `tests/integration/harness-agent-e2e.test.ts` | Full pipeline run with a fake agent that records minimal valid artifacts via the `harness_*` tools |

Mocking strategy: build a `fakeAgentSession` factory that takes a `tools-and-replies` script and replays it. Reuse the pattern from `tests/ultraplan/authoring/intake-stage.test.ts` (or whatever ultraplan's test fakes look like — check there first).

---

## 6. Risks + open questions

| Risk | Mitigation |
|---|---|
| Agent emits malformed artifact, deterministic baseline gone | Always run deterministic first; agent only augments / overrides specific fields |
| Research fan-out overruns budget on huge polyglot repos | Hard cap at 8 topics (already in `buildResearchTopicPlan`); make the fan-out concurrency cap configurable (default 4) |
| Session leak on cancellation | Mandatory try/finally in `runHarnessAgentStage`; tests for both throw and timeout paths |
| Model registry double-registration crash on per-topic researcher | `resolveHarnessResearchModel` already wraps in try/catch — keep this; add a test that calls it twice with the same slug |
| Agent tool-call returns ok but persists corrupted JSON | Validator runs AFTER persist (already true in the deterministic stages); add a re-load + schema-check step in `runWithAgent` |
| Default-agent prompts drift from tool surface | Add a smoke test that asserts every `default-agents/*.md` mentions every tool the stage advertises (lint at test time) |

**Open question:** should the agent path be the default once it lands, or stay opt-in via a `mode: "agent"` flag? Recommendation: stay opt-in for one release, then flip the default after telemetry confirms ≥80% of stages succeed without retry. The deterministic fallback always remains available.

---

## 7. Acceptance criteria

- `runHarnessAgentStage` exists, has cancellation + dispose semantics covered by tests.
- Each of the six stages has a `runWithAgent` path; deterministic path remains untouched.
- Research fan-out spawns N parallel sessions, succeeds on partial completion, cancels via signal.
- Per-stage subcommands in `command.ts` work: `/supi:harness discover` runs Discover with the agent, `/supi:harness research` runs Research, etc.
- `bun typecheck` clean, `bun test` clean.
- New tests cover the contract above (≥6 new test files).
- Integration e2e test demonstrates a fake agent walking the pipeline end-to-end and producing a passing Validate report.

---

## 8. Sequencing (recommended)

1. **Land follow-on #1 + #2 first** (HarnessPlanStage spec wiring + per-stage CLI subcommands with deterministic runners). One small session.
2. Then land this doc's work in this order:
   1. `runHarnessAgentStage` + tests
   2. Discover hybrid (smallest agent role — augmentation only)
   3. Research hybrid (fan-out)
   4. Design hybrid
   5. Validate hybrid (surfacing path; agent only triages, does not author)
   6. Pipeline + command wiring + e2e test
3. Skip Plan + Implement hybrid for v1: Plan is a deterministic builder fed by an in-memory spec; Implement runs through the existing `/supi:plan` approval flow which already has its own agent integration.

---

## 9. Anti-goals

- Do **not** introduce a new abstraction over `createAgentSession`. Use it directly.
- Do **not** make the agent path the default in v1. Opt-in until telemetry proves it.
- Do **not** spawn agents from the runtime hooks (pre-edit probe, post-session sweep, layer-context inject). Those stay deterministic — agent-session per hook event would blow the latency budget.
- Do **not** persist agent-session state across stages. Each stage is a fresh session.
