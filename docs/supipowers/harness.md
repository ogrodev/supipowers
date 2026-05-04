# `/supi:harness` — Harness-Engineering Pipeline + Anti-Slop Guardrails

A six-phase pipeline that turns an arbitrary codebase into a *harness-friendly* one — agent-neutral docs, mechanically enforced architecture rules, structural tests, evals — plus a persistent **anti-slop** layer that catches the failure modes LLMs reliably fall into (duplicating shared code, leaving dead code after sessions, drifting from architectural boundaries).

## Quick start

```bash
# Install the harness for the current repo (interactive)
/supi:harness

# Drive a single stage
/supi:harness discover
/supi:harness research
/supi:harness design
/supi:harness plan-draft
/supi:harness implement
/supi:harness validate

# Inspect / drive the queue
/supi:harness status
/supi:harness backlog
/supi:harness next
/supi:harness resolve <id>
/supi:harness score
/supi:harness gc
```

Bare entry on a harness-installed repo prompts **harden** (gap-fill), **rebuild** (regenerate with confirmation), or **cancel**.

## Architecture

The pipeline mirrors `/supi:ultraplan`:
- Each stage runs as a fresh `platform.createAgentSession` with a per-stage system prompt.
- Stage runners are idempotent: re-running a completed stage is a no-op.
- Per-stage typed artifacts persist under `~/.omp/supipowers/projects/<slug>/harness/sessions/<sessionId>/`.
- The Plan stage hands off to the existing OMP plan-mode approval flow (`src/planning/approval-flow.ts`), so users approve a harness plan the same way they approve any other plan.

## Output tiers

|Tier|Location|Audience|
|---|---|---|
|1 (agent-neutral)|`AGENTS.md`, `docs/architecture.md`, `docs/golden-principles.md`, native lint configs at repo root|Codex, Claude Code, Cursor, supipowers, any harness|
|2 (supipowers-aware)|`.omp/supipowers/config.json` gate wiring + `.omp/supipowers/review-agents/harness-architecture.md`|`/supi:checks` and `/supi:review`|
|3 (anti-slop runtime)|Slop queue, score, hook bindings|Persistent guardrails on every agent session|

## Anti-slop layer

### Pre-edit duplication probe

Registered on `tool_call` for `write` / `edit`. Stages the proposed write into a shadow copy, runs an incremental duplicate scan on the affected subtree, and blocks when the proposed content matches an existing implementation above threshold:

```
{ block: true, reason: "Duplicate of <path>:<line>; reuse instead" }
```

Performance budget: ≤500 ms p95 on a 50k-LOC repo. On timeout, the probe is skipped with a one-line warning — we never block the agent on perf.

### Post-session dead-code sweep

Registered on `agent_end`. Runs `fallow dead-code --changed-since HEAD --format json` (or the selected backend's equivalent) on changed files, diffs against the previous snapshot, and appends new unused exports / files to the queue.

### Layer-aware context injection

Registered on `before_agent_start`. Reads `docs/architecture.md` and prepends a system-prompt addendum tailored to the file the agent is about to edit:

```
You are editing <file> in the <layer> layer.
Permitted imports: <list>.
Forbidden:        <list>.
See docs/architecture.md.
```

Capped at 800 chars (configurable). Degrades gracefully when `docs/architecture.md` is absent.

### Persistent slop queue

JSONL file at `~/.omp/supipowers/projects/<slug>/harness/queue.jsonl`. One record per violation:

```json
{
  "id": "fa05e1b2-…",
  "kind": "duplicate",
  "file": "src/foo.ts",
  "range": { "startLine": 10, "endLine": 30 },
  "severity": "warning",
  "source": "fallow",
  "state": "open",
  "message": "Near-duplicate of src/bar.ts:42",
  "ts": "2026-05-03T…"
}
```

Append-only with atomic temp+rename for state changes. Reader tolerates a trailing partial line after a crash.

### Game-resistant scorecard

Two scores (0–100):
- **Lenient** ignores `wontfix` items.
- **Strict** counts them as cost — so mass `wontfix` cannot game the score.

Score floor in config gates `/supi:checks` and CI. Defaults: lenient ≥90, strict ≥75, non-blocking.

### Architecture-aware LLM reviewer

Auto-generated `.omp/supipowers/review-agents/harness-architecture.md` plugs into `/supi:review` multi-agent pipeline; reviews PRs against the layered-domain rules and golden principles.

## Backend matrix

|Repo profile|Recommended|Notes|
|---|---|---|
|TypeScript / JavaScript only|`fallow` + supi-native|fallow's static analysis is fast (suffix-array dup detection ≤500 ms p95)|
|3+ languages, or Python / Rust / Go|`desloppify`|29-language coverage, ships as a `pip install`|
|TS-dominant + non-TS subtrees|`hybrid`|fallow on the TS subtree, desloppify on the rest|
|Niche / no external CLIs allowed|`supi-native`|Manual lint/dupe tooling per stack — Discover surfaces options|

The user always overrides the recommendation in Design.

## Configuration

```json
{
  "harness": {
    "anti_slop": {
      "pre_edit_dupe_probe": { "enabled": true, "threshold": 0.85, "min_token_count": 30 },
      "post_session_sweep": { "enabled": true, "block_on_new_dead_code": false },
      "layer_context_inject": { "enabled": true, "addendum_max_chars": 800 },
      "score_floor": { "strict": 75, "lenient": 90, "release_blocking": false }
    },
    "backend": "fallow",
    "implement_in_session_threshold": 10
  }
}
```

`implement_in_session_threshold` (default 10): when the approved plan has ≤N tasks, Implement runs in-session via steer (mirrors `/supi:plan`). When >N, it hands off to `/supi:ultraplan` batch / worktree runtime.

## Lifecycle

1. **Install** (`/supi:harness`): six-phase pipeline produces the artifacts and writes `.omp/supipowers/harness/marker.json`.
2. **Use**: hooks fire on every agent session in this repo. Slop violations land in the queue.
3. **Triage** (`/supi:harness backlog` / `next` / `resolve`): drain the queue manually as you work.
4. **GC** (`/supi:harness gc`): re-runs Validate, drains the queue automatically (mechanical fixes only), reports judgmental items.
5. **Score**: lenient + strict score recomputed at the end of Validate / GC. Repo-local snapshot at `.omp/supipowers/harness/score.json` is committable.

## Cross-platform

- **fallow**: ships native binaries for macOS, Linux, Windows. Adapter falls back to `npx fallow` if not on PATH.
- **desloppify**: requires Python ≥3.11 (cross-platform). Adapter checks `python --version` before any call.
- **Hooks**: deterministic node/bun-native code, no platform-specific assumptions.

## Files

|Path|Purpose|
|---|---|
|`src/harness/command.ts`|Top-level dispatcher|
|`src/harness/bare-entry.ts`|Detect existing harness, prompt harden/rebuild/cancel|
|`src/harness/pipeline.ts`|Driver loop|
|`src/harness/stages/*.ts`|Per-stage runners|
|`src/harness/anti_slop/*.ts`|Backend abstraction, queue, score, architecture parser|
|`src/harness/hooks/*.ts`|Pre-edit probe, post-session sweep, layer inject|
|`src/harness/gc/*.ts`|GC driver + mechanical fixers|
|`src/harness/artifacts/*.ts`|Per-tier artifact emitters|
|`src/harness/default-agents/*.md`|Per-stage agent system prompts|
