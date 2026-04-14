# OMP Autoresearch System

Autoresearch is OMP's built-in automated optimization loop. It lets the agent iteratively modify code, run benchmarks, and keep or revert changes based on metric results — all on an isolated git branch with full rollback safety.

This document covers how the system works internally and how to use it effectively.

---

## How It Works

### The Core Loop

Autoresearch is a **tool-gated optimization loop**. The agent makes one experiment at a time: modifies code, runs a benchmark, interprets the result, then either commits the improvement or reverts the change. It repeats until interrupted or an iteration cap is reached.

```
/autoresearch "optimize X"
        │
        ▼
┌─ Interactive Setup ─────────────────────┐
│  Intent, benchmark cmd, metric,         │
│  direction, scope, off-limits,          │
│  constraints                            │
└─────────────────────────────────────────┘
        │
        ▼
  Create autoresearch/<slug> git branch
        │
        ▼
  Agent writes autoresearch.md + autoresearch.sh
        │
        ▼
  init_experiment (validates contract)
        │
        ▼
  Run & log baseline
        │
        ▼
┌─ Iteration Loop ───────────────────────┐
│  1. Modify code (scoped files only)    │
│  2. run_experiment                     │
│  3. Interpret result                   │
│  4. log_experiment                     │
│     ├─ keep    → auto-commit           │
│     ├─ discard → auto-revert           │
│     ├─ crash   → auto-revert           │
│     └─ checks_failed → auto-revert    │
│  5. Repeat                             │
└─────────────────────────────────────────┘
```

### Three Custom Tools

When autoresearch mode activates, three tools become available to the agent (they are inactive by default):

**`init_experiment`** — Initializes or resets the experiment session. Validates that all parameters (benchmark command, metric, direction, scope paths, off-limits, constraints) match what is declared in `autoresearch.md`. Writes the initial config entry to `autoresearch.jsonl`. Each re-initialization starts a new "segment" and requires a fresh baseline.

**`run_experiment`** — Executes the benchmark command (must be `autoresearch.sh`), captures timing, parses structured `METRIC name=value` output lines, and optionally runs `autoresearch.checks.sh` as a quality gate. Stores per-run artifacts under `.autoresearch/runs/`.

**`log_experiment`** — Records the result with one of four statuses:
- `keep` — primary metric improved; auto-commits scoped files on the autoresearch branch
- `discard` — metric regressed or stayed flat; auto-reverts via `git restore` + `git clean`
- `crash` — benchmark failed (nonzero exit, timeout); auto-reverts
- `checks_failed` — benchmark passed but `autoresearch.checks.sh` failed; auto-reverts

Persists results to `autoresearch.jsonl`, updates the dashboard, and computes confidence.

### Git Branch Isolation

Every autoresearch session runs on a dedicated branch named `autoresearch/<slugified-goal>-<date>`. The system:

- Requires a clean git worktree before starting (uncommitted changes block activation)
- Creates the branch automatically on first run, reuses it on resume
- On `keep`: stages only files within the declared scope and commits with metric metadata in the message
- On `discard`/`crash`/`checks_failed`: runs `git restore --staged --worktree .` followed by `git clean` to fully revert, while preserving autoresearch state files

### Guardrails

The system intercepts tool calls during autoresearch mode to enforce safety:

- **Write/edit guards**: The `tool_call` event hook blocks `write`, `edit`, and `ast_edit` operations that target files outside the declared scope or within off-limits paths.
- **Bash guards**: Shell commands are validated against mutation patterns. Commands that modify files (`rm`, `mv`, `sed -i`, `git commit`, redirects, etc.) are blocked. Only read-only inspection is allowed via bash; file changes must go through `write`/`edit`/`ast_edit` so scope enforcement applies.
- **Benchmark command enforcement**: `run_experiment` rejects commands that don't invoke `autoresearch.sh` when the script exists.
- **Contract validation**: `init_experiment` validates that every parameter matches `autoresearch.md` exactly. If the contract or scripts change mid-session, a segment fingerprint mismatch error forces re-initialization.

### The Contract: `autoresearch.md`

`autoresearch.md` is the single source of truth for the experiment. It is a markdown file with specific `##` sections that the system parses:

```md
# Autoresearch

## Goal
- Reduce API response latency

## Benchmark
- command: bash autoresearch.sh
- primary metric: p99_latency_ms
- metric unit: ms
- direction: lower
- secondary metrics: throughput_rps, memory_mb

## Files in Scope
- src/server/handlers/
- src/server/middleware/

## Off Limits
- src/server/config.ts
- tests/fixtures/

## Constraints
- All existing tests must pass
- No breaking API changes

## Baseline
- metric: 245ms
- notes: measured on commit abc1234

## Current best
- metric: 198ms
- why it won: connection pooling + query batching

## What's Been Tried
- experiment: inline caching for hot paths
- lesson: marginal gain (2ms), not worth the complexity
```

The system parses the `Benchmark`, `Files in Scope`, `Off Limits`, and `Constraints` sections to enforce the contract at the tool level.

### Benchmark Output Format

The benchmark script (`autoresearch.sh`) communicates metrics by printing structured lines to stdout:

```
METRIC p99_latency_ms=198.5
METRIC throughput_rps=1250
METRIC memory_mb=384
```

Format: `METRIC <name>=<value>` where name uses `[a-zA-Z0-9_.µ-]` characters and value is a number. The primary metric (declared in the contract) is the decision maker; secondary metrics are tracked for regression awareness.

Additionally, `ASI` (Actionable Side Information) lines can be emitted for structured metadata:

```
ASI hypothesis=connection pooling reduces handshake overhead
ASI next_action_hint=try batching queries next
```

### ASI (Actionable Side Information)

Every `log_experiment` call requires ASI data to capture what was learned:

- **Always required**: `hypothesis` — what the experiment tested and why
- **Required on non-keep results**: `rollback_reason` — why it didn't work; `next_action_hint` — what to try next

This creates an audit trail of reasoning, not just code changes.

### Confidence Score

After 3+ runs in a segment, the system computes a confidence score:

```
confidence = |bestKept - baseline| / MAD
```

Where MAD is the median absolute deviation of all metric values in the segment. This compares the observed improvement against the noise floor:

- `>= 2.0x` — likely a real improvement
- `>= 1.0x` — marginal, may be noise
- `< 1.0x` — within noise, re-run to confirm

### Segments

A segment is a contiguous sequence of experiments with the same contract. Reinitializing (calling `init_experiment` again) starts a new segment, which:

- Increments the segment counter
- Requires a fresh baseline run
- Preserves all previous results in `autoresearch.jsonl` (history is append-only)

Changes to `autoresearch.md`, `autoresearch.sh`, or `autoresearch.checks.sh` invalidate the current segment's fingerprint, forcing a re-init before the next run.

### Auto-Resume

The system keeps the loop running across agent turns:

1. After each `log_experiment`, `autoResumeArmed` is set to `true`
2. When the agent finishes its turn (`agent_end` event), the system checks if autoresearch mode is active and resume is armed
3. If so, it injects a resume message that tells the agent to read `autoresearch.md`, inspect `autoresearch.jsonl` and git history, handle any pending unlogged run, and continue iterating

This means the agent will keep optimizing until you interrupt it or the iteration cap is reached.

### Dashboard

A TUI widget shows experiment progress in real time:

- **Collapsed view** (default): one-line summary with current metric, best result, delta %, and confidence
- **Expanded view** (`Ctrl+X`): multi-line table of all runs in the current segment
- **Overlay** (`Ctrl+Shift+X`): full-screen scrollable dashboard with run history, secondary metrics, and navigation (arrow keys, Page Up/Down, `g`/`G` for top/bottom)

---

## Files on Disk

| File | Committed | Purpose |
|------|-----------|---------|
| `autoresearch.md` | Yes | Contract: goal, benchmark config, scope, off-limits, constraints, notes |
| `autoresearch.sh` | Yes | Benchmark entrypoint script; must print `METRIC name=value` lines |
| `autoresearch.checks.sh` | Yes | Optional quality gate run after passing benchmarks |
| `autoresearch.program.md` | Yes | Durable heuristics, failure patterns, repo-specific strategy for future sessions |
| `autoresearch.ideas.md` | Yes | Deferred experiment backlog; scratch pad for promising but inactive ideas |
| `autoresearch.jsonl` | No | Append-only run history (config entries + experiment results) |
| `.autoresearch/runs/` | No | Per-run artifacts: `run.json`, benchmark logs, checks logs |

---

## How to Use It

### Starting a New Session

```
/autoresearch optimize database query performance
```

The interactive setup wizard prompts for:

1. **Intent**: What to optimize (pre-filled from your argument)
2. **Benchmark command**: Must invoke `autoresearch.sh` (default: `bash autoresearch.sh`)
3. **Primary metric name**: e.g., `query_time_ms`, `throughput_rps`
4. **Metric unit**: e.g., `ms`, `rps`, `kb`
5. **Direction**: `lower` or `higher` is better
6. **Secondary metrics**: Comma-separated additional metrics to track
7. **Scope paths**: Files/directories the agent may modify
8. **Off-limits paths**: Files that must never change
9. **Constraints**: Invariants that must hold (e.g., "all tests pass")

After setup, the agent:
- Creates a dedicated git branch
- Writes `autoresearch.md` and `autoresearch.sh`
- Runs the baseline benchmark
- Starts iterating

### Resuming an Existing Session

If `autoresearch.md` already exists when you run `/autoresearch`, the system resumes instead of starting fresh. It reads the existing notes, inspects git history and `autoresearch.jsonl`, and continues from the most promising unfinished direction.

You can add context to the resume:

```
/autoresearch try a different approach for connection pooling
```

### Stopping

```
/autoresearch off
```

Disables autoresearch mode and removes the experiment tools. Your branch and all committed experiments remain intact.

### Clearing State

```
/autoresearch clear
```

Deletes `autoresearch.jsonl` and `.autoresearch/` local state, then disables autoresearch mode. The branch and committed code changes are not affected.

### Writing the Benchmark Script

`autoresearch.sh` is the canonical benchmark entrypoint. It must:

1. Run the actual workload
2. Print `METRIC <name>=<value>` lines to stdout for every metric
3. Exit with code 0 on success, nonzero on failure

Example for a TypeScript test suite:

```bash
#!/bin/bash
set -euo pipefail

# Run the benchmark
start=$(date +%s%3N)
bun test --bail 2>/dev/null
end=$(date +%s%3N)

duration=$((end - start))
echo "METRIC test_duration_ms=$duration"

# Count passing tests
pass_count=$(bun test 2>&1 | grep -c "pass" || true)
echo "METRIC passing_tests=$pass_count"
```

Example for a web server latency benchmark:

```bash
#!/bin/bash
set -euo pipefail

# Start server in background
bun run src/server.ts &
SERVER_PID=$!
sleep 2

# Run load test
result=$(wrk -t4 -c100 -d10s http://localhost:3000/api/data 2>&1)

# Parse metrics
latency=$(echo "$result" | grep "Latency" | awk '{print $2}' | sed 's/ms//')
rps=$(echo "$result" | grep "Req/Sec" | awk '{print $2}')

echo "METRIC p99_latency_ms=$latency"
echo "METRIC throughput_rps=$rps"

kill $SERVER_PID 2>/dev/null
```

### Adding a Quality Gate

Create `autoresearch.checks.sh` to add a hard gate that runs after every passing benchmark:

```bash
#!/bin/bash
set -euo pipefail

# Type check
bun run typecheck

# Run full test suite
bun test

# Check bundle size hasn't exploded
size=$(du -sk dist/ | cut -f1)
if [ "$size" -gt 500 ]; then
  echo "Bundle size exceeded 500kb: ${size}kb"
  exit 1
fi
```

If checks fail, the agent must log the result as `checks_failed` (not `keep`), and the changes are auto-reverted.

### Practical Tips

**Start with existing measurement infrastructure.** If your project already has benchmarks, test suites, or CI scripts that produce numbers, point autoresearch at those. Creating a benchmark from scratch adds setup cost.

**Keep scope narrow.** The tighter the scope (fewer files in scope), the more focused the agent's experiments will be. Broad scope leads to scattered, hard-to-evaluate changes.

**Use off-limits for measurement code.** Put your benchmark scripts, test fixtures, evaluators, and ground-truth data in off-limits. If the agent optimizes by changing the measurement, the results are meaningless.

**Set constraints for correctness gates.** "All existing tests must pass" is a good baseline constraint. Without it, the agent might improve the metric by breaking functionality.

**Watch the confidence score.** Improvements below 1.0x confidence are likely noise. The agent is instructed to re-run when confidence is low, but you should also be skeptical of small gains.

**Use `autoresearch.ideas.md` for backlog.** The agent maintains a separate ideas file for promising experiments that aren't being pursued right now. This prevents losing good ideas during focused iteration.

**Review the branch before merging.** Autoresearch commits are atomic per-experiment, so you can cherry-pick, squash, or review individual improvements on the `autoresearch/*` branch before merging to your main branch.

---

## Example Use Cases

**Test suite speed**: Metric: `test_duration_ms`, direction: `lower`. Agent tries parallelizing tests, removing redundant setup, inlining fixtures, caching expensive operations.

**Bundle size reduction**: Metric: `bundle_kb`, direction: `lower`. Agent tries tree-shaking, replacing heavy dependencies, dead-code elimination. Checks gate: test suite must still pass.

**API response latency**: Metric: `p99_latency_ms`, direction: `lower`. Agent tries connection pooling, query optimization, caching, serialization improvements. Secondary metrics: `throughput_rps`, `memory_mb`.

**LLM prompt accuracy**: Metric: `accuracy_pct`, direction: `higher`. Agent iterates on prompt wording, few-shot examples, system prompt structure. Off-limits: the evaluation harness and test datasets.

**Build time**: Metric: `build_time_ms`, direction: `lower`. Agent tries import restructuring, removing circular dependencies, splitting large files. Scope: source files only, not build config.

**Parser throughput**: Metric: `ops_per_sec`, direction: `higher`. Agent tries algorithmic improvements, buffer strategies, avoiding allocations. Checks: existing test suite ensures correctness.
