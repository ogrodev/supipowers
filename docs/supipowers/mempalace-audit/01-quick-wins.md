# Landing Order #1 — Quick Wins

**Scope.** Pure correctness fixes and documentation tightening. Small, low-risk, foundational. The schema↔python drift test added here prevents future landings from re-introducing the bugs in (B).

**Findings addressed.** A, B, C, E, F, K, S, P, T1, T2.

**Depends on.** Nothing. Run first.

**Files in scope.**
- `src/mempalace/schema.ts`
- `src/mempalace/runtime.ts`
- `src/mempalace/hooks.ts` (only the 4 timeout-passing call sites)
- `src/mempalace/python/mempalace_bridge.py`
- `tests/mempalace/schema.test.ts` (new table-driven test)
- `tests/mempalace/runtime.test.ts`
- `tests/mempalace/hooks.test.ts`

## Required changes

### 1. Hook timeout unit fix (A)

**Problem.** `src/mempalace/hooks.ts:262, 280, 327, 367` pass `timeout: resolved.timeouts.hookMs` (10000). `src/mempalace/bridge.ts:resolveToolTimeoutMs` multiplies `params.timeout * 1000` and caps at `bridgeMs` (30 s). Net effect: the intended 10 s hook budget collapses to the 30 s bridge default on every hook call.

**Fix.** Pass `Math.max(1, Math.round(hookMs / 1000))` at each call site, **or** drop the `timeout` field from those calls and rely on the bridge default. Pick one approach consistently across all four call sites and document the choice in a one-line comment.

### 2. Schema↔python signature alignment (B, C, K, S)

**Problem.** Several `REQUIRED_FIELDS` entries in `src/mempalace/schema.ts` don't match the actual python `tool_*` signatures and dispatch extractors in `src/mempalace/python/mempalace_bridge.py:MCP_TOOL_DISPATCH`. Today the agent sees a python `TypeError` deep in the bridge instead of a clean supipowers-side validation error.

Concrete fixes:
- `add_drawer`: require `wing, room, content` (currently only `content`).
- `kg_invalidate`: require `subject, predicate, object` (currently only `subject, predicate`).
- `kg_invalidate.ended`: schema type is `boolean`, python expects an ISO date string. Change the schema to `string` (with a docstring noting the ISO format) and reject `boolean`.
- `find_tunnels`: drop the `source_room` requirement entirely — python's `tool_find_tunnels(wing_a=None, wing_b=None)` doesn't accept it, the `_select` extractor silently drops it. Remove `source_room` from the schema parameter list as well.
- `diary_write` / `diary_read`: add `agent_name` to `REQUIRED_FIELDS`. (Hooks always supply it via `defaultAgentName`; direct agent calls currently fail confusingly inside python.)
- `list_drawers`: keep `wing` as required, **but** update the tool description to explain why (avoids accidental full-palace dump) and document `offset` for pagination.

### 3. CLI args `repair` cleanup (E)

**Problem.** `buildMempalaceCliArgs` in `src/mempalace/runtime.ts:573` builds `repair` with a positional `dir`. The python-side `_make_cli_args_repair` (`mempalace_bridge.py:325`) deliberately omits it because `mempalace repair` is a global palace op and argparse exits code 2 on unrecognized arguments. Currently only used in tests — remove the dir argument from the `repair` branch in the TypeScript helper to match python.

### 4. Double-timeout in `runBridgeRequest` (F)

**Problem.** `src/mempalace/runtime.ts` has both `defaultProcessRunner` (SIGKILL after `timeoutMs`) and a `Promise.race` setTimeout firing at the same deadline. The outer `setTimeout` is never cleared on a fast response.

**Fix.** Track the timer handle, clear it in a `.finally` so the event loop doesn't carry an orphaned timer.

### 5. Comment on env mutation in the python bridge (P)

`_apply_palace_path` in `src/mempalace/python/mempalace_bridge.py:130` mutates `os.environ`. Fresh process per call today, so this is safe — but flag the assumption in a comment so any future daemon refactor (Landing Order #5) doesn't silently inherit a stale env. One-line comment, no behavior change.

### 6. Tests

#### 6a. Schema↔python dispatch drift test (T2)

Add `tests/mempalace/schema.test.ts` (or extend if it already exists) with a table-driven test that, for every action in `MCP_TOOL_DISPATCH`:
- Loads the python signature via a static fixture file mirroring `MCP_TOOL_DISPATCH` (keep this fixture in `tests/mempalace/fixtures/python-signatures.json` — the python side is the source of truth, so the test compares the schema against the fixture and the fixture is updated by hand whenever the python signatures change).
- Asserts every required python positional argument is present in `REQUIRED_FIELDS`.
- Asserts every supipowers field maps to either a recognized python keyword or is intentionally documented as "renamed via `_rename`".

The intent is *not* to introspect python at runtime — it's to make schema drift a CI-visible failure rather than a runtime python `TypeError`.

#### 6b. Timeout unit test (T1)

Extend `tests/mempalace/hooks.test.ts` to assert the `timeoutMs` that reaches the bridge runner from a hook call is ≤ `hookMs`. Use a stub bridge that captures the `params.timeout` it receives. Without this, A regresses silently.

#### 6c. `repair` CLI args test

Extend `tests/mempalace/runtime.test.ts` to assert `buildMempalaceCliArgs("repair", { dir: "/whatever" })` does **not** include `/whatever` in the argv.

## Acceptance criteria

- [ ] Every hook call site in `hooks.ts` passes a timeout that, after the bridge's `* 1000`, is ≤ `hookMs`. A failing test added in 6b proves it.
- [ ] `add_drawer`, `kg_invalidate`, `find_tunnels`, `diary_write`, `diary_read` schemas match `MCP_TOOL_DISPATCH` exactly. The drift test in 6a passes.
- [ ] `kg_invalidate.ended` is typed as an ISO date string in the schema, with rejection of boolean values verified by an existing or new schema validation test.
- [ ] `find_tunnels.source_room` is gone from the schema (parameter list **and** required fields).
- [ ] `list_drawers` description explicitly explains the `wing` requirement and documents `offset`.
- [ ] `buildMempalaceCliArgs("repair", { dir })` ignores `dir`.
- [ ] `runBridgeRequest`'s timeout is cleared on settle (no orphan timer). A test that resolves the runner promise before timeout asserts the timer was cleared.
- [ ] `_apply_palace_path` has a comment flagging the env mutation assumption for daemon refactors.
- [ ] `bun test tests/mempalace/` passes locally with zero regressions.
- [ ] `bun ci` passes.

## Non-goals

- Do **not** change hook gating, cache lifetimes, retry behavior, write serialization, source_file plumbing, or auto-search heuristics — those land in #2–#4.
- Do **not** add daemon mode or batched actions — that's #5.
- Do **not** rewrite the schema validator. Keep changes localized to the listed entries.

## Reviewer checklist

- [ ] Drift test fails when a schema entry is deliberately broken (verify by temporarily removing `wing` from `add_drawer` required fields and watching the test red).
- [ ] No new dead code (no unused imports, no commented-out blocks).
- [ ] No production behavior change beyond the items listed above.
