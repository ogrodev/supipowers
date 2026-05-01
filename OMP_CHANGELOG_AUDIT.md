# OMP Changelog Audit — supipowers

| | |
|---|---|
| **OMP version range analyzed** | 14.5.0 → 14.5.12 |
| **supipowers version at audit** | 1.5.3 |
| **Audit date** | 2026-04-30 |
| **Audit scope** | Runtime API surface in `src/`, agent-facing prompts/skills, and test fixtures |

> Verdict: **3 critical breaking changes**, all introduced before 14.5.12 (one in 14.5.4, one in 14.5.4, one in 14.5.11). Each silently degrades a major feature without surfacing an error in the harness. Combined: 113 stale call sites across runtime code, prompts shipped to LLM agents, and test fixtures. Tests currently give false green because production and assertions agree on the *old* wire shape.

---

## Breaking Changes

### BC-1 — MCP tool prefix `mcp_<server>_<tool>` → `mcp__<server>_<tool>` (14.5.4)

**Severity:** CRITICAL. Bricks `/supi:ui-design` pencil-mcp backend.

**What changed.** OMP 14.5.4 renamed every MCP tool from single-underscore to double-underscore form (`mcp_pencil_batch_design` → `mcp__pencil_batch_design`). The change applies to active-tool listings, persisted MCP selections, and every wire reference. supipowers' `active-tool-planner` already uses the double-underscore form (`tests/tool-catalog/active-tool-planner.test.ts:17` asserts `isSupiOwnedTool("mcp__server__tool")` is `false`), but the Pencil-MCP backend still hardcodes the single-underscore form everywhere.

**Evidence (53 occurrences — abbreviated).**

| File:line | Category | Snippet | Effect |
|---|---|---|---|
| `src/ui-design/backends/pencil-mcp.ts:17-18` | runtime | `"mcp_pencil_batch_design"`, `"mcp_pencil_batch_get"` in `REQUIRED_PENCIL_TOOLS` | `detectPencilMcp()` always returns `false`; backend startup throws `BackendUnavailableError` for every `/supi:ui-design` session. |
| `src/ui-design/backends/pencil-mcp.ts:59` | runtime | Error message references stale names | User-visible error message names tools that don't exist. |
| `src/ui-design/system-prompt.ts:114-205` | prompt | 11 references in phase table, hard-gate rules, tool-routing table | Director agent is instructed to call `mcp_pencil_open_document`, `mcp_pencil_batch_design`, `mcp_pencil_batch_get`, `mcp_pencil_export_nodes`, `mcp_pencil_get_editor_state`, `mcp_pencil_set_variables`, `mcp_pencil_replace_all_matching_properties` — all of which 404 at the wire. |
| `src/ui-design/session.ts:77` | prompt | Resume steer: ``Re-open `${penFilePath}` via `mcp_pencil_open_document` `` | Resume flow tells agent to call non-existent tool. |
| `src/ui-design/prompt-builder.ts:29` | prompt | Phase 2 kickoff line | Same. |
| `src/ui-design/pen-scanner.ts:5`, `pen-selector.ts:6`, `prompt-builder.ts:9`, `system-prompt.ts:142,146,150,161`, `pencil-mcp.ts:12,24,44` | comment (10 sites) | JSDoc/inline comments document `mcp_<server>_<tool>` convention | Misleads next maintainer. |
| `skills/ui-design/sub-agent-templates/pencil/component-builder.md:9,16,19` | prompt | `mcp_pencil_batch_design`, `mcp_pencil_set_variables`, `mcp_pencil_replace_all_matching_properties` | Component-builder sub-agent calls fail. |
| `skills/ui-design/sub-agent-templates/pencil/design-critic.md:9,15-17` | prompt | `mcp_pencil_get_screenshot`, `mcp_pencil_snapshot_layout`, `mcp_pencil_search_all_unique_properties` | Design-critic sub-agent calls fail. |
| `skills/ui-design/sub-agent-templates/pencil/section-assembler.md:9,19` | prompt | Same pattern | Section-assembler sub-agent calls fail. |
| `tests/ui-design/backends/pencil-mcp.test.ts:14-16,26` | test | Active-tools mock + `detectPencilMcp([...])` assertions | Green only because production also uses the stale form. |
| `tests/ui-design/system-prompt.test.ts:154,155,167,187,198,199` | test | `expect(prompt).toContain("mcp_pencil_*")` | Locks in stale prompt content. |
| `tests/ui-design/session.test.ts:834` | test | `expect(steer).toContain("mcp_pencil_open_document")` | Same. |
| `tests/commands/ui-design.test.ts:372-374,424-425,482-483,535-536` | test | Active-tools mocks across 4 test groups | Same. |
| `tests/context-mode/hooks.test.ts:855,866` | test | `"mcp_context_mode_ctx_search"` fixture + comment | Tests the legacy context-mode MCP wrapping; harmless in itself but documents stale convention. |

**Recommendation.** Single global rename: `mcp_pencil_` → `mcp__pencil_` and `mcp_<server>_` → `mcp__<server>_` across `src/` (22 sites), `tests/` (22 sites), and `skills/` (9 sites).

```bash
# Suggested rewrite (verify against single-underscore convention is fully retired in 14.5.4):
ast_edit ops=[
  { pat: "\"mcp_pencil_batch_design\"", out: "\"mcp__pencil_batch_design\"" },
  { pat: "\"mcp_pencil_batch_get\"",    out: "\"mcp__pencil_batch_get\"" },
  { pat: "\"mcp_pencil_open_document\"", out: "\"mcp__pencil_open_document\"" },
  …
] path="src/,tests/,skills/"
```

Pair with a one-time test run of `bun test tests/ui-design/` and `bun test tests/commands/ui-design.test.ts` to confirm the rename touches every active fixture.

---

### BC-2 — `grep` tool → `search` (14.5.4)

**Status:** RESOLVED in this patch. supipowers now uses `search` as the canonical internal tool key. The legacy word `grep` remains only as a natural-language lazy-tool trigger so prompts like "grep TODOs" still activate the context-mode search replacement.

**What changed.** OMP 14.5.4 renamed the built-in `grep` tool to `search`, including event names, settings keys (`search.enabled`, `search.contextBefore`, `search.contextAfter`), and SDK identifiers.

**Resolution implemented.**

| Surface | Current behavior |
|---|---|
| Runtime processor keys | `src/context-mode/metrics-store.ts` schema v2 uses `search`; schema migration rewrites legacy `grep` rows to `search`. |
| Compression / metrics | `src/context-mode/compressor.ts` and `src/context-mode/metrics-recorder.ts` resolve processor keys through `processorKeyForTool`, so `search` output is compressed and recorded. |
| Event extraction / resume | `src/context-mode/event-extractor.ts` switches on `search`; `snapshot-builder.ts` consumes the 14.5.11 `todo_write` shape. |
| Routing / failure taxonomy | `src/context-mode/routing.ts` blocks native `search`; `src/discipline/failure-taxonomy.ts` classifies blocked `search` as `wrong-tool-path`. |
| Source hashing | `src/context-mode/source-hash.ts` hashes `search` calls for L3 cache stability. |
| Prompt/lazy-tool compatibility | `src/tool-catalog/tool-groups.ts` keeps both `search` and `grep` prompt keywords mapped to `ctx_batch_execute`; this is a wording alias, not a second runtime representation. |
| Skills/tests | Context-mode skills and tests now refer to `search` for the built-in tool name. |

**Regression coverage.** The affected tests feed `toolName: "search"` through routing, compression, event extraction, source hashing, metrics recording, run-emission, planning-tool filtering, and failure taxonomy paths. `tests/tool-catalog/active-tool-planner.test.ts` also preserves `grep` as a prompt keyword trigger.


---

### BC-3 — `todo_write` reshape (14.5.11)

**Severity:** CRITICAL. Bricks `/supi:plan` execution handoff and the `<pending_tasks>` resume snapshot.

**What changed.** 14.5.11 reshaped `todo_write` ops:

| Was (≤ 14.5.10) | Now (14.5.11+) |
|---|---|
| `op: "replace"` | `op: "init"` |
| `phases: [{ name, tasks: [{ content }] }]` | `list: [{ phase, items: string[] }]` |
| `append` items: `[{ id, label }]` | `append` items: `string[]` |
| Synthetic `task-N` / `phase-N` ids | Identity is task `content` and phase `name` verbatim |
| Phase names accepted `"I. Foo"` / `"1. Foo"` / `"Phase 1: Foo"` | Numeric/roman prefix forbidden; renderer numbers visually |

**Evidence (32 occurrences).**

Runtime (11 sites):

| File:line | Snippet | Effect |
|---|---|---|
| `src/planning/approval-flow.ts:93-98` | `TodoWriteOp` type union with `op: "replace"`, `phases: [{ name; tasks: [{ content }] }]` | Local type lies about wire shape. |
| `src/planning/approval-flow.ts:117-138` | `buildTodoWriteOpsForPlan` constructs `{ op: "replace", phases: [{ name: "I. Implementation", tasks: [{ content }] }] }` and `{ op: "note", task: "task-${index+1}" }` | The payload is `JSON.stringify`'d into the execution-handoff prompt at `:165` and the agent is told "call `todo_write` with exactly this payload". OMP rejects/misbehaves on the stale shape. The `I.` prefix in the phase name is also forbidden. The `task-N` synthetic id is invalid — the new contract uses the task's `content` verbatim, so notes will not bind to any task. |
| `src/context-mode/snapshot-builder.ts:354-388` | `extractTaskContent` switches on `verb === "replace"` reading `rawOp.phases`, `task.content`, and `append` items shaped as `{label}` | After 14.5.11, agents emit `op: "init"`, `list:`, plain task strings, and plain `append` strings. None of those branches match → `<pending_tasks>` is silently empty for every resume snapshot. |
| `src/planning/approval-flow.ts:87,109,113,134` | Comments calling out the stale shape | Misleads maintainers. |

Tests (21 sites): `tests/planning/todo-payload.test.ts:32-92` (test description, op-name assertion, type narrowing, phase-key access, task-shape assertion, synthetic-id assertion) — every assertion encodes the old shape; `tests/planning/approval-flow.test.ts:231-234` asserts the embedded prompt contains `"op": "replace"`, `"name": "I. Implementation"`, `"task": "task-1"`, `"content": "..."`; `tests/context-mode/snapshot-builder.test.ts:53,168,285-289,303,358` (5 fixtures) feed `op: "replace"`/`phases:` shapes; `tests/context-mode/event-extractor.test.ts:242-244` (1 fixture) same.

**Recommendation — coordinated rewrite.**

1. **`src/planning/approval-flow.ts`** — replace the `TodoWriteOp` union and `buildTodoWriteOpsForPlan` body:

   ```ts
   type TodoWriteOp =
     | { op: "init"; list: Array<{ phase: string; items: string[] }> }
     | { op: "note"; task: string; text: string };

   export function buildTodoWriteOpsForPlan(plan: Plan): { ops: TodoWriteOp[] } {
     if (plan.tasks.length === 0) return { ops: [] };
     const items = plan.tasks.map((t) => truncateTaskLabel(t.name));
     const ops: TodoWriteOp[] = [
       { op: "init", list: [{ phase: "Implementation", items }] }, // no "I." prefix
     ];
     for (const task of plan.tasks) {
       const trimmed = task.criteria.trim();
       if (!trimmed) continue;
       // Identity is the task's content verbatim. Must match what was in `items`.
       ops.push({ op: "note", task: truncateTaskLabel(task.name), text: trimmed });
     }
     return { ops };
   }
   ```

   Both occurrences of `truncateTaskLabel(...)` must be applied identically so the `note.task` matches the `init.list[].items[]` content exactly — that's the new identity contract.

2. **`src/context-mode/snapshot-builder.ts:354-388`** — update `extractTaskContent` to read the new shape:

   ```ts
   if (verb === "init" && Array.isArray(rawOp.list)) {
     for (const phase of rawOp.list as Array<Record<string, unknown>>) {
       const items = Array.isArray(phase?.items) ? phase.items : [];
       for (const item of items) {
         if (typeof item === "string" && item) parts.push(`init: ${item}`);
       }
     }
   } else if (verb === "append" && Array.isArray(rawOp.items)) {
     for (const item of rawOp.items) {
       if (typeof item === "string" && item) parts.push(`append: ${item}`);
     }
   } else if (verb === "note") { /* unchanged */ }
   ```

   Keep the legacy `replace`/`phases`/`{label}` branches under a feature flag for one release cycle if older OMP installs are still in the field — otherwise delete them outright (clean cutover).

3. **Tests** — rewrite `tests/planning/todo-payload.test.ts`, `tests/planning/approval-flow.test.ts:231-234`, `tests/context-mode/snapshot-builder.test.ts` (lines 53/168/285-289/303/358), and `tests/context-mode/event-extractor.test.ts:242-244` to assert the new shape. The renaming is trivial but **MUST** be done in lockstep — these are the false-green machines.

4. **Comments** — update `src/planning/approval-flow.ts:87,109,113,134` to describe the 14.5.11 shape; remove any "OMP 14.4.0" reference.

---

### Confirmed non-impacts

The following changelog entries were verified to NOT affect supipowers:

| Changelog | Reason |
|---|---|
| 14.5.12 — browser tool legacy verbs removed; `app.path`/`app.cdp_url` added | supipowers does not use the OMP `browser` tool. Visual companion runs its own HTTP server in `src/visual/` (verified — no `browser` tool calls in `src/`). |
| 14.5.12 — plan mode auto-redirect of `write/edit` to `local://PLAN.md` | supipowers writes plans to `.omp/supipowers/plans/YYYY-MM-DD-<slug>.md` (`src/storage/plans.ts:8-9`). The planning system prompt explicitly forbids writing to `local://PLAN.md`. No collision. |
| 14.5.10 — `pr_checkout` worktree/branch removed; array support on `pr_view`/`pr_diff`/`pr_checkout`; per-repo lock | supipowers does not use OMP's `github` tool — all GitHub ops shell out via `platform.exec("gh", […])` (`src/commands/fix-pr.ts:163,176`, `src/commands/release.ts:238`, `src/commands/doctor.ts:172,180`, `src/release/channels/github.ts`). |
| 14.5.10 — removed `./hooks` and `./hooks/*` package exports | supipowers does not import any subpath of `@oh-my-pi/*`. Only top-level imports (`@oh-my-pi/pi-tui`, `@oh-my-pi/pi-ai`). |
| 14.5.10 — diff preview / git.remote.add / suspicious-duplicate / bash interceptor / LSP shutdown | These affect tools the OMP runtime exposes to spawned agents. supipowers does not depend on the diff renderer, the warning text, or LSP shutdown timing. |
| 14.5.9 — atom edit shorthands (`^Lid+TEXT`, range-replace, `LidA..LidB=TEXT`, `!rm`/`!mv`) | Edit-tool syntax used by spawned agents. supipowers does not generate atom payloads. Skills are tool-syntax-agnostic by design (verified: zero atom/shorthand references in `skills/`). |
| 14.5.8 — `just` → `run_command` rename | supipowers does not reference either tool name. Verified via repo-wide search. |
| 14.5.7 — Ctrl+Enter NumLock fix | Hook-editor TUI fix; no impact. |
| 14.5.6 — atom multi-anchor auto-rebase | Edit-tool fix; no impact. |
| 14.5.5 — atom diff parse / duplicate-line warning / anchor rebase | Edit-tool fixes; no impact. |
| 14.5.4 — atom JSON → input language; `read.defaultLimit` 300→500; streaming diff previews | supipowers does not generate atom/patch/replace/hashline payloads. |
| 14.5.3 — atom splice bracketed `loc`, `splice_block` | Edit-tool fix; no impact. |
| 14.5.2 — sed-style requires `{pat,rep}` object | Edit-tool fix; no impact. |
| 14.5.1 — escaped-tab autocorrect removed | Edit-tool change; no impact. |

---

## Opportunities

Most opportunities are skipped because supipowers' OMP integration is mature and the new APIs do not address current pain points. The two worth tracking are **O2 (tokenizer)** and **O5 (IRC relay)**, both of which depend on or interact with future OMP API exposure.

### O1 — Built-in `/context` slash command (14.5.9)

**Priority:** P3 · **Effort:** — · **Recommendation:** SKIP

OMP's built-in `/context` exposes only the raw `getContextUsage()` totals. supipowers' `/supi:context` (`src/commands/context.ts:23-143`) layers four extras on top:

- Per-section byte breakdown via `parseSystemPrompt` + `buildBreakdownItems` (`src/context/analyzer.ts:27-375`)
- L1 metrics savings panel from the SQLite `MetricsStore` (`src/context/savings.ts`)
- First-run notice + project slug + session metadata
- Tool-list rendering via `formatToolsReport`

None of this is in OMP's built-in. No duplication; no slimming opportunity.

### O2 — Tokenizer-based estimates (14.5.9)

**Priority:** P2 · **Effort:** XS-S · **Recommendation:** CONSIDER (depends on OMP API exposure)

`src/context/analyzer.ts:4-6` uses chars/4:
```ts
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
```
Consumed by `buildBreakdownItems` (per-section "~Xk tok" labels) and `src/context/savings.ts:14` (savings column). The chars/4 heuristic underestimates code-heavy text by ~30%.

**Action.** No tokenizer API is currently exposed on `Platform`/`PlatformContext` (verified: zero `tokenize` matches in `src/platform/types.ts` or installed `@oh-my-pi/*`). Track an OMP-side request to expose the same tokenizer they now use internally; on exposure, this is a one-line swap. Until then, retain the `~` prefix on display labels to communicate approximation.

### O3 — `search` tool internal URL support (14.5.4)

**Priority:** P3 · **Effort:** — · **Recommendation:** SKIP

The new `search` tool accepts `artifact://` paths. supipowers' artifact handling at `src/storage/review-sessions.ts:20-36` uses `resolveArtifactPath()` with explicit traversal-boundary enforcement and direct `fs.readFileSync`. Adopting `search(artifact://)` would introduce unnecessary tool-call coupling and lose the local traversal guard.

### O4 — `after_provider_response` event (14.5.4)

**Priority:** P3 · **Effort:** — · **Recommendation:** SKIP

The installed OMP event catalog (per `node_modules/@oh-my-pi/pi-coding-agent` hooks docs) does not include an event named `after_provider_response`. The change description appears to refer to an internal observer not exposed via `pi.on(...)`. Reliability metrics (`src/storage/reliability-metrics.ts`) are already correctly written from the `tool_result` interception path and do not need provider-level events.

### O5 — IRC relay observation in main UI (14.5.4)

**Priority:** P3 · **Effort:** — · **Recommendation:** SKIP

`src/review/multi-agent-runner.ts:62-93` injects IRC coordination text into agent prompts when `activeTools.includes("irc")` (line 74). supipowers does not register a renderer for IRC messages, so the new main-UI relay introduces no double-render risk. Gating is correct and tested at `tests/review/multi-agent-runner.test.ts:139-212`.

### O6 — Plan-mode auto-redirect of `write`/`edit` to `local://PLAN.md` (14.5.12)

**Priority:** P1 · **Effort:** XS · **Recommendation:** SKIP (already guarded)

OMP now auto-redirects bare `PLAN.md` writes to `local://PLAN.md`. supipowers writes to `.omp/supipowers/plans/YYYY-MM-DD-<slug>.md` (`src/storage/plans.ts:8-9`); the planning system prompt explicitly forbids writing to `local://PLAN.md`. The `agent_end` hook (`src/planning/approval-flow.ts:6`) only inspects `.omp/supipowers/plans/`, so OMP-managed `local://PLAN.md` artifacts will never be picked up regardless. No change needed.

### O7 — Atom edit shorthand (14.5.9)

**Priority:** P3 · **Effort:** — · **Recommendation:** SKIP

Edit-tool syntax consumed by spawned agents. `skills/` is intentionally tool-agnostic (verified: zero matches for atom/shorthand/`^L` patterns) — pinning skills to OMP-version-specific syntax would couple skills to a release line and break older installs.

---

## Summary table

| ID | Item | Type | Severity / Priority | Effort | Recommendation | Evidence count |
|---|---|---|---|---|---|---|
| BC-1 | `mcp_<server>_<tool>` → `mcp__<server>_<tool>` (14.5.4) | Breaking | RESOLVED | M (53 sites) | DONE — renamed across `src/`, `tests/`, `skills/` | 53 |
| BC-2 | `grep` → `search` tool rename (14.5.4) | Breaking | RESOLVED | M (full internal rename) | DONE — `search` is canonical; metrics-store schema v2 migrates legacy rows; `grep` retained only as a prompt-keyword alias | 28 |
| BC-3 | `todo_write` reshape (14.5.11) | Breaking | RESOLVED | S (4 source files + 4 test files) | DONE — `buildTodoWriteOpsForPlan`/`extractTaskContent` and asserting tests rewritten | 32 |
| O1 | `/context` built-in | Opportunity | P3 | — | SKIP — supipowers provides strictly more | — |
| O2 | Tokenizer-based estimates | Opportunity | P2 | XS-S | CONSIDER — depends on OMP API exposure | — |
| O3 | `search` + `artifact://` | Opportunity | P3 | — | SKIP — would lose traversal guard | — |
| O4 | `after_provider_response` event | Opportunity | P3 | — | SKIP — event not in installed catalog | — |
| O5 | IRC relay in main UI | Opportunity | P3 | — | SKIP — no double-render | — |
| O6 | Plan-mode auto-redirect | Opportunity | P1 | XS | SKIP — already guarded | — |
| O7 | Atom edit shorthand | Opportunity | P3 | — | SKIP — skills intentionally tool-agnostic | — |

---

## Rollout status

All three breaking changes shipped together in this patch:

1. **BC-2 (`grep` → `search`)** — canonical key flipped to `search`; metrics-store schema bumped to v2 with a migration that rewrites legacy `grep` rows to `search` and nulls their unique source hashes. `grep` survives only as a prompt-keyword alias mapped to `ctx_batch_execute`.
2. **BC-1 (`mcp_*` → `mcp__*`)** — mechanical rename across `src/`, `tests/`, and `skills/`. Verified by `bun test tests/ui-design tests/commands/ui-design.test.ts`.
3. **BC-3 (`todo_write` reshape)** — `src/planning/approval-flow.ts`, `src/context-mode/snapshot-builder.ts`, and the asserting tests now use the flat `init`/`append`/`note` shape. Task identity is content, not synthetic id.
