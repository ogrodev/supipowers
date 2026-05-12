# Landing Order #2 — Hooks Gating + Cache Hygiene

**Scope.** Stop the bridge from spawning when MemPalace is not installed; correct per-session cache invalidation; bound long-running cache growth.

**Findings addressed.** G, I, J.

**Depends on.** #1 (`hooks.ts` timeout changes land first to avoid merge conflicts in the same handler).

**Files in scope.**
- `src/mempalace/hooks.ts`
- `src/mempalace/installer-helper.ts` (export the snapshot helper used by hooks)
- `tests/mempalace/hooks.test.ts`

## Required changes

### 1. Gate hook registration on install readiness (G)

**Problem.** `registerMempalaceTool` already gates on `snapshotMempalaceInstall(...).ready` so a missing install doesn't surface as a dead tool. `registerMempalaceHooks` does not — every turn pays a ~200–500 ms python spawn that fails with `mempalace_missing` and falls back to `setupGuidanceBlock`.

**Fix.**
- At hook registration time, call `snapshotMempalaceInstall(platform.paths, process.cwd(), config)` once.
- When `snapshot.ready === false`, register **only** a static guidance hook that injects the same content `setupGuidanceBlock(resolved, wing)` produces today — but with **no** bridge call. Skip wake-up, auto-search, compaction-checkpoint, and shutdown-diary handlers entirely.
- When `snapshot.ready === true`, register the full hook surface as today.

Acceptable refinements:
- A `forceRecheck` escape hatch (e.g. cache invalidated on the `omp:install-finished` event if that event exists, or on a configurable interval) so install-then-use within one OMP session works without restart. If no event exists, do **not** invent one — document the restart requirement in the hook module's leading comment.
- The static guidance block must be rendered once and cached (string is identical every turn).

### 2. Per-session `clearAll` (I)

**Problem.** `wakeUpCache` and `turnCounters` are module-level Maps keyed by `${sessionId}|${wing}|${palace}`. The current `clearAll` handler wipes the whole map on `session_start` / `session_switch`, evicting other sessions' state.

**Fix.** Replace `clearAll` with a per-session clear that:
- Reads `event.sessionId` (and `event.previousSessionId` if `session_switch` payloads provide it; otherwise just the active sessionId).
- Iterates keys and deletes only those whose prefix matches the affected sessionId.
- If the event payload doesn't carry a sessionId, fall back to the current "wipe everything" behavior — but log a warning via `platform.logger?.warn` so this stays observable. Do **not** silently no-op.

### 3. Bounded cache growth (J)

**Problem.** `wakeUpCache` and `turnCounters` grow unbounded across (sessionId, wing, palace) combinations.

**Fix.** Wrap both maps in a small bounded LRU (size 64 entries is fine — sessions are short-lived in practice). When `session_shutdown` events exist on the platform, hook them to drop matching entries proactively. Implementation:
- Use a tiny purpose-built LRU (insertion-ordered `Map`, drop the oldest key when over capacity) — do not add a dependency.
- Expose `_resetMempalaceHookState()` (already exists for tests) so the new LRU resets cleanly.

## Test additions

- A test that asserts `before_agent_start` returns the static guidance string **without** invoking the bridge when `snapshotMempalaceInstall` reports `ready: false`. Use a mock `snapshotInstall` injected via `MempalaceHooksDeps`.
- A test that `session_switch` for session A does not evict session B's `wakeUpCache` entry.
- A test that the LRU evicts the oldest entry when over the configured size. Drive it via `_resetMempalaceHookState()` between cases.

## Acceptance criteria

- [ ] When MemPalace is not installed, `before_agent_start` returns the cached guidance block and `bridge.execute` is never called. Test proves it.
- [ ] `session_switch` only evicts cache entries for the affected sessionId(s). Test with two sessions proves it.
- [ ] `wakeUpCache.size` and `turnCounters.size` never exceed the configured LRU cap under a flood of unique session/wing combinations. Test proves it.
- [ ] No new module-level state escapes `_resetMempalaceHookState()`.
- [ ] `bun test tests/mempalace/hooks.test.ts` and `bun ci` pass.

## Non-goals

- Do **not** add retry logic — that lands in #3.
- Do **not** change auto-search heuristics — that lands in #4.
- Do **not** change `formatMempalaceResult` or schema — those are #1 / #4 territory.

## Reviewer checklist

- [ ] Static guidance block matches `setupGuidanceBlock`'s current output exactly so users see no regression when MemPalace is missing.
- [ ] LRU cap is a named constant, not an inline magic number.
- [ ] No use of `setInterval` or any background timer for cache reaping. Eviction is purely on insert/event.
