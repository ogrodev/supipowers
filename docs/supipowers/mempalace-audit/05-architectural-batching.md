# Landing Order #5 — Batched `wake_up + search` Action

**Scope.** Halve per-turn python spawns by combining the two parallel bridge calls in `before_agent_start` into a single `wake_up_and_search` action that runs both tool functions inside one python process.

**Findings addressed.** H.

**Depends on.** #1 (schema/dispatch stable), #2 (hook gating cached — avoids spawning when not installed).

**Files in scope.**
- `src/mempalace/python/mempalace_bridge.py` (new dispatch entry)
- `src/mempalace/schema.ts` (new action + params)
- `src/mempalace/bridge.ts` (no API change beyond passing the new action through)
- `src/mempalace/format.ts` (formatter for the composite result)
- `src/mempalace/hooks.ts` (use the new action in `before_agent_start`)
- `tests/mempalace/schema.test.ts`, `tests/mempalace/format.test.ts`, `tests/mempalace/hooks.test.ts`, `tests/mempalace/bridge.test.ts`

## Background

`before_agent_start` currently runs:
```ts
const [wakeBlock, searchBlock] = await Promise.all([wakePromise, searchPromise]);
```

Two python processes spawn in parallel. Cold path: ~1.0–3.0 s for both. Combining them into one python call avoids the second process spawn (and the second `import chromadb`).

## Required changes

### 1. New python dispatch entry

Add an action `wake_up_and_search` to `mempalace_bridge.py` that:
- Accepts the union of params: `wing`, `query`, `limit`.
- Imports `mempalace.layers` and `mempalace.mcp_server` once.
- Calls `MemoryStack(...).wake_up(wing=...)` and `mcp_server.tool_search(query=..., wing=..., limit=...)`.
- Returns `{ wake: { text: ... }, search: { ...tool_search payload... } }` — both keyed under stable names so `formatMempalaceResult` can dispatch.
- If `query` is absent or empty, skips the search and returns `{ wake: ..., search: null }`. `wake` is **never** optional.
- If `wake_up` raises, the action still returns the partial `{ wake: null, search: ... }` payload with a `wake_error` field in the response — do not let one half kill the other.

This action lives **only** in `MCP_TOOL_DISPATCH`-adjacent dispatch (a hand-written handler is fine; it's a composite). Do not pollute the existing `tool_*` table.

### 2. Schema

Add `wake_up_and_search` to `MempalaceAction` and the validation schema:
- Required: none (mirrors today's hook behavior — `wing` resolved server-side via options).
- Optional: `wing`, `query`, `limit`, `timeout`, `palace`.

### 3. Formatter

Add `formatWakeUpAndSearch` in `format.ts`:
- Renders the wake block (same shape as today's `formatSearch` for `wake_up`) followed by the search block (today's `formatSearch` for `search`).
- When `search` is null, omits the search section entirely.
- When `wake` is null (failed half), emits a single-line notice instead of the wake block so the operator can see something failed without poisoning the turn.

### 4. Hook wiring

In `before_agent_start`:
- Replace the two-promise structure with a single `bridge.execute({ action: "wake_up_and_search", ... })` call **on the cadence-gated turn** (the turn where `isFullInjectionTurn === true`).
- On non-injection turns, keep the lightweight `wakeUpRefresher` + per-prompt search behavior unchanged (the refresher path doesn't need a bridge call).
- Preserve auto-search heuristic from #4 — if the prompt does not warrant search, omit `query` from the batched call so python skips it.

The `wakeUpCache` continues to cache the wake block (not the combined block — the search part is per-prompt).

## Test additions

- **`tests/mempalace/schema.test.ts`**: validates `wake_up_and_search` accepts/rejects the documented param set.
- **`tests/mempalace/format.test.ts`**: tests for full payload, search-null payload, wake-null payload.
- **`tests/mempalace/hooks.test.ts`**: assert exactly one `bridge.execute` call on the cadence-gated turn (not two). Use a counting stub.
- **`tests/mempalace/bridge.test.ts`**: round-trip through the runner stub to verify params propagate correctly to the python dispatch.

## Acceptance criteria

- [ ] `before_agent_start` issues exactly one `bridge.execute` call per cadence-gated turn (assert via stub spy).
- [ ] When `wake_up` succeeds but search fails, the user still sees the wake block; when wake fails but search succeeds, the user still sees the search hits with a one-line wake-failure notice.
- [ ] Existing single-action calls (`wake_up` alone, `search` alone) still work — the new action is purely additive.
- [ ] No change in observable behavior on non-injection turns (refresher path).
- [ ] Auto-search heuristic from #4 continues to gate whether `query` is sent.
- [ ] `bun test tests/mempalace/` and `bun ci` pass.

## Non-goals

- Do **not** introduce a long-lived python daemon. That's a larger design pass tracked separately.
- Do **not** batch any other action pairs — start with the one that demonstrably runs every turn.
- Do **not** rewrite `formatSearch` or `formatWakeUp`. Reuse them inside the new formatter.

## Reviewer checklist

- [ ] No regression in cold-start latency: time the hook against the old path with `performance.now()` in a benchmark test (informational, not gating).
- [ ] Hook still produces identical text output to today's `Promise.all` path when both halves succeed (golden-string test).
- [ ] Python handler's exception isolation is unit-tested — patch one of the two underlying functions to throw, verify the response shape.
