# Landing Order #3 — Write Durability

**Scope.** Make hook-driven writes (compaction checkpoint, shutdown diary) durable: end-to-end `source_file` round-trip, in-process write serialization, transient-failure retry.

**Findings addressed.** D, N, O, T3.

**Depends on.** #1 (schema + python dispatch are stable).

**Files in scope.**
- `src/mempalace/bridge.ts`
- `src/mempalace/session-summary.ts`
- `src/mempalace/python/mempalace_bridge.py`
- `tests/mempalace/bridge.test.ts`
- `tests/mempalace/session-summary.test.ts`
- New: `tests/mempalace/integration/diary-roundtrip.test.ts` (optional but recommended)

## Required changes

### 1. End-to-end `source_file` round-trip (D)

**Problem.** `session-summary.ts:181, 195` build `source_file: "omp-session:<id>:<reason>:<ts>"` and `tests/mempalace/hooks.test.ts:398` asserts it on the supipowers-side call. But the python dispatch in `mempalace_bridge.py:242` is `_select("agent_name", "entry", "topic", "wing")` — `source_file` is silently dropped before reaching ChromaDB. Session → diary linkage is gone.

**Fix.** Pick one of:
- **Option 1 (preferred).** Update the python `MCP_TOOL_DISPATCH` entry for `diary_write` to include `source_file` and pass it through to `tool_diary_write`'s underlying writer. If the upstream `mempalace.mcp_server.tool_diary_write` does not accept `source_file`, call the lower-level writer directly (`mempalace.diary.write_entry` or equivalent — confirm the actual export by inspecting the installed package).
- **Option 2 (fallback).** If the upstream library has no path for `source_file` and we can't add one cleanly from the bridge, embed it deterministically in the entry text (e.g. prepend `[source: <source_file>]\n`) and document the convention in `session-summary.ts`. Drop the `source_file` field from `MempalaceParams` in `schema.ts` so the schema reflects reality.

In **both** cases the existing `hooks.test.ts:398` assertion must be updated to assert the actual end-state, not the dropped field.

### 2. Per-palace write serialization (O)

**Problem.** ChromaDB's sqlite layer can surface "database is locked" when writes overlap. Hook `before_agent_start` reads (wake_up + search) are fine in parallel, but compaction (`add_drawer`) and shutdown (`diary_write`) handlers can in principle overlap with agent-driven writes from the same OMP process.

**Fix.** Add a per-palace mutex in `src/mempalace/bridge.ts`:
- Keyed by the resolved palace path.
- Engages only for write actions: `add_drawer`, `update_drawer`, `delete_drawer`, `diary_write`, `kg_add`, `kg_invalidate`, `create_tunnel`, `delete_tunnel`. Read actions skip the mutex entirely.
- Implementation: a tiny `Map<palacePath, Promise>` where each enqueued operation `await`s the previous tail and replaces it. No external deps.

Operations from different palaces (multiple workspaces sharing one OMP) must not serialize against each other.

### 3. Retry on transient bridge failures (N)

**Problem.** `bridge_timeout` and `bridge_process_failed` are best-effort for hook writes today. A single retry would meaningfully improve durability of compaction checkpoints and shutdown diaries (write-once payloads, low retry cost).

**Fix.** Add a retry wrapper inside `bridge.execute` that:
- Triggers **only** for actions in a `RETRY_ON_TRANSIENT` allowlist: `add_drawer`, `diary_write`, `kg_add`, `kg_invalidate`. Never retry searches, reads, taxonomy queries — re-running them is pointless overhead.
- Triggers **only** for error codes `bridge_timeout` and `bridge_process_failed`. Never retry `invalid_params`, `mempalace_missing`, or any domain error from the python side.
- Max one retry with a fixed 150 ms backoff. No exponential, no jitter — keep it predictable.
- Surface the retry attempt in `diagnostics.retries` (integer) so the caller can observe it.

## Test additions

- **`tests/mempalace/bridge.test.ts`**:
  - Two concurrent `add_drawer` calls against the same palace are observed by the runner sequentially (the second runner invocation does not start until the first resolves). Use a runner stub that records start timestamps and asserts non-overlap.
  - Two concurrent writes against different palaces **do** run in parallel.
  - A `bridge_timeout` on `add_drawer` triggers exactly one retry, then resolves successfully on the second attempt. `diagnostics.retries === 1`.
  - A `bridge_timeout` on `search` triggers **zero** retries.
  - An `invalid_params` error on `add_drawer` triggers **zero** retries.

- **`tests/mempalace/integration/diary-roundtrip.test.ts`** (gated by the managed venv being installed, skipped otherwise):
  - Calls `diary_write` with a unique `source_file`, then `diary_read`, and asserts the entry's stored metadata or text carries the `source_file` marker. Skip cleanly with `console.warn` if `snapshotMempalaceInstall(...).ready === false`.

- **`tests/mempalace/session-summary.test.ts`**: update existing fixtures if you chose Option 2 (text-embedded `source_file`).

## Acceptance criteria

- [ ] Calling `diary_write` from a hook results in an entry that, when read back, carries the `source_file` marker (either as metadata or as a deterministic prefix in `entry`). Round-trip test proves it.
- [ ] Concurrent writes to the same palace are observed sequentially by the bridge runner. Concurrent writes to different palaces are not serialized.
- [ ] `add_drawer` and `diary_write` retry exactly once on `bridge_timeout` / `bridge_process_failed`; no other action retries; no other error code triggers retry. Diagnostics include `retries`.
- [ ] `bun test tests/mempalace/` passes. `bun ci` passes.

## Non-goals

- Do **not** add cross-process locking (lockfiles, advisory locks). The in-process mutex is sufficient; one OMP process is the only writer that matters in practice.
- Do **not** change retry policy for `agent`-initiated actions (search, list, get_drawer). Keep retries scoped to the hook-driven write allowlist.
- Do **not** introduce a new daemon — that's #5.

## Reviewer checklist

- [ ] Mutex map does not leak entries when palaces churn (entries are GC-friendly — only the tail promise is referenced).
- [ ] Retry path is observable in `result.diagnostics`, not buried in logs.
- [ ] Round-trip test is skipped (not failed) when the managed venv is absent.
