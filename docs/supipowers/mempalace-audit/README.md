# MemPalace Audit — Landing Plan

A full-pass review of `src/mempalace/` produced 19 actionable findings (correctness bugs `A–F`, architectural opportunities `G–S`, test gaps `T1–T3`). This directory groups them into five self-contained landing orders, plus one orchestration document that drives implementation through subagents.

## Landing orders

| # | Doc | Scope | Files touched | Depends on |
|---|---|---|---|---|
| 1 | [`01-quick-wins.md`](./01-quick-wins.md) | Pure correctness + docs (A, B, C, E, F, K, S, P, T1, T2) | `src/mempalace/schema.ts`, `src/mempalace/runtime.ts`, `src/mempalace/hooks.ts`, `src/mempalace/python/mempalace_bridge.py`, `tests/mempalace/` | — |
| 2 | [`02-hooks-gating-cache.md`](./02-hooks-gating-cache.md) | Hooks gating + cache hygiene + retry (G, I, J) | `src/mempalace/hooks.ts`, `src/mempalace/installer-helper.ts`, `tests/mempalace/hooks.test.ts` | #1 |
| 3 | [`03-write-durability.md`](./03-write-durability.md) | `source_file` round-trip + concurrent writes + transient-failure retry (D, N, O, T3) | `src/mempalace/bridge.ts`, `src/mempalace/session-summary.ts`, `src/mempalace/python/mempalace_bridge.py`, `tests/mempalace/` | #1 |
| 4 | [`04-search-and-format-polish.md`](./04-search-and-format-polish.md) | Auto-search heuristics + formatter polish + tunable cutoffs (L, M, Q, R) | `src/mempalace/hooks.ts`, `src/mempalace/format.ts`, `src/mempalace/schema.ts`, `src/types.ts`, `tests/mempalace/` | #1 |
| 5 | [`05-architectural-batching.md`](./05-architectural-batching.md) | Batched wake-up+search to halve per-turn python spawns (H) | `src/mempalace/bridge.ts`, `src/mempalace/hooks.ts`, `src/mempalace/python/mempalace_bridge.py`, `tests/mempalace/` | #1, #2 |

## Orchestration

[`ORCHESTRATION.md`](./ORCHESTRATION.md) drives implementation through the `task` tool, parallelizing #2/#3/#4 after #1 lands, then runs cross-check + gap-fix + full CI.

## Out of scope for this audit

- Data migration for the `sij-mono` → `sij_mono` divergence (already fixed in code; one-time `update_drawer` walk is documented separately).
- Replacing the fork-per-call bridge with a long-lived python daemon (a larger design pass; the batched action in #5 captures the easy win without that lift).
