# Improvement opportunities — post OMP 14.5.0 → 14.5.12 cutover

Follow-ups identified after executing `OMP_145_BREAKING_CHANGES_FIX_PLAN.md`. Ranked by value; each item names the exact file/symbol so the next pass can start from the same evidence.

## High-value (likely worth doing)

### 1. `src/tool-catalog/tool-groups.ts` keyword map still routes `grep` to `ctx_batch_execute`

Lines 35-37:

```ts
search: ["ctx_batch_execute"],
find:   ["ctx_batch_execute"],
grep:   ["ctx_batch_execute"],
```

Now that the canonical native tool is `search`, the `grep:` keyword entry is a duplicate that exists only because the AI agent might still type "grep". Two coherent options:

- Drop the `grep` keyword entirely (it's redundant with `search`).
- Keep it, but document it as "user prose only — not a canonical tool name."

### 2. `BLOCKED_TOOLS` in `src/discipline/failure-taxonomy.ts` is incomplete

Currently:

```ts
"search", "bash-grep", "bash-find", "curl", "wget", "fetch", "WebFetch"
```

Missing native tools that `routeToolCall` actually blocks:

- `find` — blocked when the shell-search replacement is active.
- `web_fetch` — blocked alongside `fetch`.

A failure recorded with `toolName: "find"` or `"web_fetch"` will not classify as `wrong-tool-path` today, even though it is the same class of failure as `search`/`fetch`.

### 3. `LEGACY_PROCESSOR_KEYS` is now misnamed and duplicated

After the rename, the constant is the *canonical* native-tool processor map, not a legacy one. The same is true of `PROCESSOR_BY_TOOL` in `metrics-recorder.ts` — both are de-facto aliases of the same thing. Two cleanups:

- Rename `LEGACY_PROCESSOR_KEYS` → `NATIVE_TOOL_PROCESSOR_KEYS` (or similar).
- Collapse the duplicate map. `compressor.ts` and `metrics-recorder.ts` each declare their own copy of `{ bash, read, search, find }`. Drift between the two will cause silent metric/processor mismatches.

### 4. Existing `metrics.db` rows still hold `processor: "grep"`

After upgrade:

- `ProcessorKey` no longer admits `"grep"`, but old rows in users' SQLite stores will return `processor: "grep"` at runtime.
- `getUniqueSourceShare` and the per-compressor breakdown will silently bucket old rows under a key the type system says cannot exist.
- Source-hash dedup state is also invalidated: the same `search` call after upgrade gets a new hash and will not match a pre-upgrade `grep:`-prefixed row.

Two clean options:

- Add a one-shot migration that rewrites `processor='grep'` → `'search'` and rehashes (or drops) the affected rows.
- Document the cutover behavior in the changelog and accept that the first session after upgrade re-emits compressed copies of the same sources.

### 5. The plan's execution prompt hardcodes `phase: "Implementation"` in instruction prose

`src/planning/approval-flow.ts` `buildExecutionPrompt`:

```
Task identity is the task content verbatim. Later progress updates (`start`, `done`, `note`) MUST pass `task` equal to the exact item string above; phase updates MUST pass `phase: "Implementation"`. ...
```

This is correct *today* because we always emit a single `Implementation` phase. If the planner ever diversifies phases (the OMP tracker certainly supports it), this string will lie. Worth deriving the phase name from the payload rather than literal-coding it.

## Medium-value

### 6. `extractFile` op `"search"` is emitted but never projected

`src/context-mode/event-extractor.ts` emits `op: "search"` for `search` tool calls. The snapshot builder only consumes `op === "edit" | "write" | "read"`. Reads from `search` results are dropped. Either:

- Stop emitting `search` file events (current value is zero), or
- Surface them in the snapshot under a `searched` bucket alongside `edited` / `read`.

### 7. Comment on `extractTaskContent`'s legacy-fallback branch is now stale

After the rewrite, the `else` branch in `src/context-mode/snapshot-builder.ts` still parses `rawOp.content` as a free-form `verb: <text>` projection. That branch is the *only* surviving legacy path and the surrounding comments still hint at the old `replace`/`phases` shape. Consider tightening the comment to "generic fallback for unknown verbs (`add_task`, etc.); not part of the OMP 14.5.11+ spec."

### 8. `tests/context-mode/snapshot-builder.test.ts` still uses placeholder phase names

The new tests use `"Implementation"`, `"Foundation"`, `"Auth"`, but two surviving tests use `"II. Auth"` (in the legacy-content paths). These tests still pass, but the name "II. Auth" only made sense under the old roman-prefix convention. Worth dropping the prefix for consistency.

### 9. The `pencil` skill templates use the same `mcp__pencil_*` rename, but no test asserts the templates themselves

The skill markdown files were updated by hand. There is no test that loads them and asserts their tool references match the canonical detection list (`REQUIRED_PENCIL_TOOLS`). A small consistency test would catch future drift between detection, the system prompt, and the skill templates.

## Low-value (note and move on)

### 10. `omp_source/AGENTS.md` is referenced by repo-level rules but was not read this pass

The session's `<dir-context>` calls for reading `omp_source/AGENTS.md` before touching anything in `omp_source/`. Nothing under `omp_source/` was changed, so this is not a regression — but if `omp_source/` documents the OMP wire format that just changed, it may also need an update. Worth a 30-second pass.

### 11. `docs/autoresearch-omp-system.md` has shell `grep` examples

These are legitimate shell examples. No change needed — flagging only because the verification search surfaced them.

### 12. `tests/commands/ui-design.test.ts` "wizard offers pencil-mcp" test depends on alphabetical fallthrough behavior

That test path comments "alphabetical entry deterministically" but the new tool-name set still happens to sort the same way. Not broken, just brittle.

### 13. The grouped sub-agent test for context-mode hooks is documented as "current behavior" rather than a contract

`tests/context-mode/hooks.test.ts:854` says: "If this behavior changes in the future (e.g. recognizing `mcp_*_ctx_*` names), this test will fail loudly." With the new `mcp__` prefix, that is now even more likely to change. Worth reframing as either a contract ("MCP-prefixed tools must NOT be classified as native") or a reminder TODO ("Detect `mcp__<server>_ctx_*` and classify them as ctx tools").

---

**Recommended order to act on these:** #2 (taxonomy completeness), #3 (collapse the duplicate processor map), #4 (migrate or document old rows). The rest are polish or future-proofing.
