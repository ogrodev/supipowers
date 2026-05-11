---
name: harness
description: Guides the harness-engineering pipeline — turn a codebase into one that resists agentic slop with agent-neutral docs, mechanically enforced architecture, and three runtime guardrails
---

# Harness Skill

Loaded by `/supi:harness`. Drives a six-phase pipeline that turns an arbitrary codebase into a *harness-friendly* one and installs a persistent **anti-slop** layer that catches the failure modes LLMs reliably fall into.

## What it produces

- **Tier 1 — agent-neutral**: `AGENTS.md`, `docs/architecture.md`, `docs/golden-principles.md`, native lint/structural-test/eval configs at the repo root. Usable by any harness (Codex, Claude Code, Cursor, supipowers, …).
- **Tier 2 — supipowers-aware**: `.omp/supipowers/config.json` gate wiring + `.omp/supipowers/review-agents/harness-architecture.md`.
- **Tier 3 — anti-slop**: persistent slop queue, layer-aware context injection on every agent turn, pre-edit duplication probe, post-session dead-code sweep, lenient + strict scorecard, and architecture-aware LLM reviewer.

## Phases

|#|Phase|Artifact|Validator|Gate|
|---|---|---|---|---|
|1|Discover|`<session>/discover.json`|TypeBox schema + cross-check vs deps registry|user review|
|2|Research|`<session>/research/<topic>.md`|≥2 primary sources + `## Options` / `## Recommendation`|none|
|3|Design|`<session>/design-spec.md` + `<session>/decisions.jsonl`|Spec-reviewer sub-agent|user approval|
|4|Plan|`~/.omp/supipowers/projects/<slug>/plans/<plan>.md`|Reuses `validatePlanMarkdown`|OMP plan-mode UI|
|5|Implement|repo writes (Tier 1+2+3)|`bun typecheck` + `bun test` + anti-slop hooks loadable|none|
|6|Validate|`<session>/validate-report.json`|Re-runs every artifact + anti-slop scan + synthetic-edit test|user accept|
|—|GC|drift report + targeted fix sub-agents|reuses Validate|none|

Each stage runs as a fresh `platform.createAgentSession` with a per-stage prompt. Stage runners are idempotent: if the canonical artifact exists and validates, the stage is skipped.

## Gate modes

- `default`: gate at Discover review, Design approval, Plan-approval, Validate-accept.
- `auto`: end-to-end without user gates.
- `manual`: gate every stage.

## Anti-slop guardrails

Three project-scoped runtime hooks, all individually toggle-able in `.omp/supipowers/config.json`:

```json
{
  "harness": {
    "anti_slop": {
      "pre_edit_dupe_probe": { "enabled": true, "threshold": 0.85, "min_token_count": 30 },
      "post_session_sweep": { "enabled": true, "block_on_new_dead_code": false },
      "layer_context_inject": { "enabled": true, "addendum_max_chars": 800 },
      "score_floor": { "strict": 75, "lenient": 90, "release_blocking": false }
    }
  }
}
```

Hooks register only when `.omp/supipowers/harness/marker.json` exists at session start. Other repos see no behavior change.

## Backend selection

Discover recommends a backend based on repo languages; Design lets the user override:

|Repo profile|Recommended backend|Why|
|---|---|---|
|TypeScript / JavaScript only|`fallow` + supi-native|No Python dep, deepest supipowers integration|
|3+ languages, or Python/Rust/Go|`desloppify`|29-language coverage, battle-tested LLM review|
|TS-dominant + non-TS subtrees|`hybrid`|fallow on TS, desloppify on the rest|
|Niche / no external CLIs allowed|`supi-native`|Manual lint/dupe per stack|

## Score model

Scorecard has lenient + strict scores (0–100). Strict counts `wontfix` items as cost so it cannot be gamed. Score floor in config gates `/supi:checks` and CI when `release_blocking: true`.

## Subcommands

- `/supi:harness` — bare entry. New repos start the pipeline; harness-installed repos prompt **harden / rebuild / cancel**.
- `/supi:harness discover|research|design|plan-draft|implement|validate` — run/advance one stage.
- `/supi:harness resume` — resume an in-flight session.
- `/supi:harness status` — display stage + score badge.
- `/supi:harness gc` — drain the slop queue, classify mechanical vs judgmental, and dispatch fix sub-agents.
- `/supi:harness next` — pop the next unresolved queue entry.
- `/supi:harness resolve <id>` — mark an entry resolved.
- `/supi:harness backlog` — list every open entry.
- `/supi:harness score` — recompute and display the score.
- `/supi:harness pr-comment [--dry-run] [--pr=N] [--repo=owner/repo] [--session=<id>] [--mode=every-push|on-status-change]` — render (or post) the sticky PR comment for the latest validate report. See `docs/supipowers/harness/pr-comment.md`.

## Conventions you MUST follow

- Every phase persists a typed artifact before claiming done. Validate owns the completion claim.
- Re-running a phase is idempotent: unchanged inputs produce identical outputs.
- The slop queue is content-addressed; duplicate violations from different backends collapse to the same id.
- Hooks must complete in ≤500 ms p95. On timeout, emit a one-line warning and skip — never block on perf.
- Agent-neutral artifacts (Tier 1) MUST NOT depend on supipowers being installed.

## When to run

- New repo: install the harness on day 0 so the anti-slop hooks observe every change.
- Existing repo: install after a major refactor so duplicates and dead code don't compound.
- Recurring: run `/supi:harness gc` weekly (or pin to CI) to drain the queue.
