# Landing Order #4 — Search Heuristics + Format Polish

**Scope.** Make auto-search smarter, surface filter context in search output, expose previously-hardcoded relevance cutoffs as config.

**Findings addressed.** L, M, Q, R.

**Depends on.** #1 (schema is stable).

**Files in scope.**
- `src/mempalace/hooks.ts` (auto-search heuristic + `pickHits` cutoffs sourced from config)
- `src/mempalace/format.ts` (surface filters; drop dead fallbacks)
- `src/mempalace/schema.ts` (no public schema change, but the `pickHits` thresholds may be plumbed as `MempalaceConfig.budgets`)
- `src/types.ts` (extend `MempalaceConfig.budgets` if new knobs are added)
- `src/config/defaults.ts` (add defaults for new knobs)
- `tests/mempalace/format.test.ts`
- `tests/mempalace/hooks.test.ts`

## Required changes

### 1. Auto-search prompt heuristic (L)

**Problem.** `before_agent_start` runs an auto-search on every non-trivial prompt regardless of whether the prompt is question-shaped. Imperatives (`fix the bug`, `add a test`, `run the script`) cost a python spawn for negligible benefit.

**Fix.** Replace `isTrivialPrompt` with a small classifier in `hooks.ts`:
- Skip when the prompt is trivial (existing rule).
- Skip when the prompt is clearly imperative without a question signal. Heuristic:
  - Contains `?` → search.
  - Starts with (case-insensitive) `what`, `why`, `when`, `who`, `where`, `how`, `which`, `do `, `does`, `is `, `are`, `can`, `should` → search.
  - Contains any of: `remember`, `recall`, `decided`, `decision`, `chose`, `last time`, `previously`, `earlier`, `before` → search.
  - Starts with imperative verbs (`fix`, `add`, `remove`, `delete`, `run`, `update`, `refactor`, `rename`, `move`, `write`, `create`, `make`, `implement`, `build`) **and** does not match any of the search signals above → skip.
  - Otherwise → search (preserves today's recall behavior on ambiguous prompts).

Implementation: a single function with the rules above, fully unit-tested with a representative prompt table.

### 2. Surface filter context in `formatSearch` (M)

**Problem.** `tool_search` returns `result.filters` (the wing/room filter applied) and `result.total_before_filter` (how many hits were dropped). `formatSearch` ignores both. Agents seeing "0 hits" can't tell whether the palace is empty or just over-filtered.

**Fix.** In `formatSearch`:
- When `result.filters` is non-empty, append a single line under the header: `Filters applied: wing=<wing>, room=<room>` (omit absent fields).
- When `result.total_before_filter` is a number and exceeds `result.count`, append `Filtered out <N> hit(s) by wing/room scope.` so the agent can decide whether to retry with broader filters.

### 3. Drop dead fallbacks (R)

**Problem.** `formatSearch` reads `result.results ?? result.items`; `formatDrawerList` (post-recent-fix) reads `result.drawers ?? result.results ?? result.items`. Python only returns `results` / `drawers` respectively. `items` is dead.

**Fix.** Remove the `items` fallback in both formatters. Keep `results` fallback only where python genuinely returns it (verify by re-reading the python tool source). Update tests that may exercise the dead path.

### 4. Make `pickHits` cutoffs configurable (Q)

**Problem.** `hooks.ts:178-179` hardcodes `similarity ≥ 0.55` and `bm25 ≥ 0.3`. No way to tune per-project.

**Fix.**
- Extend `MempalaceConfig.budgets` with two new fields: `autoSearchSimilarityFloor: number` and `autoSearchBm25Floor: number`. Default to the current 0.55 / 0.3 values.
- Read these in `pickHits`.
- Update `src/config/defaults.ts` and any config validation in `src/config/schema.ts` so the new fields are recognized.
- Document the fields with a one-line comment each (what they bound, what the defaults mean).

## Test additions

- **`tests/mempalace/hooks.test.ts`**:
  - Table-driven test for the new prompt classifier. Include at minimum: `"why is foo broken"` (search), `"fix foo"` (skip), `"what did we decide about auth"` (search), `"refactor the bridge"` (skip), `"hello"` (skip — trivial), `"remember our caching plan"` (search), `"add tests"` (skip), `"how do retries work?"` (search).
  - `pickHits` honors the configured floors: set `autoSearchSimilarityFloor` to 0.99, prove a 0.95-similarity hit is filtered out.

- **`tests/mempalace/format.test.ts`**:
  - `formatSearch` with `filters: { wing: "foo", room: "bar" }` shows the filters line.
  - `formatSearch` with `total_before_filter: 8, count: 1` shows the "Filtered out 7 hit(s)" line.
  - `formatSearch` with no filters / no `total_before_filter` does not add the lines.

## Acceptance criteria

- [ ] Auto-search is skipped for clearly imperative prompts; preserved for questions, recall cues, and ambiguous prompts. Classifier test table is comprehensive.
- [ ] `formatSearch` surfaces filter context when present, hides it when absent.
- [ ] No dead `items` fallbacks remain in `format.ts`.
- [ ] `MempalaceConfig.budgets.autoSearchSimilarityFloor` and `autoSearchBm25Floor` are first-class config fields with defaults matching today's hardcoded values. Type system and config validator recognize them.
- [ ] `bun test tests/mempalace/` and `bun ci` pass.

## Non-goals

- Do **not** change the wake_up cadence, hook gating, or write paths — that's #2 / #3 / #5.
- Do **not** ship a heavy ML classifier for prompt detection. Plain string heuristics are correct here.
- Do **not** rename existing budget fields.

## Reviewer checklist

- [ ] Classifier rules are commented inline (one line per rule).
- [ ] Default floor values in `defaults.ts` exactly equal the previous hardcoded constants (no silent retune).
- [ ] Type changes propagate cleanly — `tsc --noEmit` is clean.
