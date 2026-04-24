# OMP Runtime Changelog Audit

- **OMP version analyzed:** 14.1.2 → 14.2.0
- **Audit date:** 2026-04-24
- **supipowers version:** 1.5.3

## Executive Summary

The OMP 14.1.2 → 14.2.0 upgrade is broadly compatible with supipowers 1.5.3. No OMP API used directly by supipowers was removed or renamed in this range.

There are two actionable follow-ups:

1. **P1:** `/supi:ui-design`'s tool guard currently derives `edit` paths from `input.path`, while OMP edit calls use `input.edits[*].path`; this blocks edit-tool writes inside UI-design sessions and becomes more visible now that Spark models default to `apply_patch` edit mode.
2. **P2:** A context-mode test fixture still models `todo_write` with the removed `ops` API shape. Production code passively records `todo_write` inputs and does not call the tool, so the runtime breaking change does not break production behavior.

## Breaking Changes

### 1. `todo_write` legacy `ops` API removed

- **Changelog entry:** 14.1.3 Breaking Changes: legacy `todo_write` `ops` API was replaced by direct top-level fields; in-place updates to task `content`, `details`, and `notes` were removed; phased task definitions now reject initial `notes`.
- **Impact:** No production callsite break found. One test fixture is stale.
- **Evidence:**
  - `src/context-mode/event-extractor.ts:95-98` passively records observed `todo_write` tool inputs into a task event; it does not construct or call `todo_write`.
  - `src/planning/approval-flow.ts:103-106` uses generic prose: “initialize todo tracking with the task list” and “update progress”; it does not prescribe the removed `ops` shape.
  - `tests/context-mode/event-extractor.test.ts:144-148` creates a fake `todo_write` event with `input: { ops: [{ op: "add_task", content: "Fix bug" }] }`, which is the removed wire shape.
- **Recommendation:** Update `tests/context-mode/event-extractor.test.ts:144-148` to use the new top-level shape, for example `input: { add_tasks: [{ phase: "Implementation", content: "Fix bug" }] }`. No production code migration is required.

### 2. `task.simple` modes and task context/schema restrictions

- **Changelog entry:** 14.1.3 Added/Fixed: `task.simple` added `default`, `schema-free`, and `independent` modes; disallowed `context`/`schema` inputs now produce mode-specific errors.
- **Impact:** No direct supipowers impact found.
- **Evidence:**
  - `src/platform/omp.ts:98-125` wraps `api.pi.createAgentSession()` but does not invoke the OMP `task` tool or configure `task.simple`.
  - `src/platform/types.ts:147-154` models agent sessions and platform capabilities; it has no task-tool schema/context contract.
- **Recommendation:** No code change. If future prompt templates instruct agents to call `task`, avoid hardcoding schema/context behavior unless the selected OMP task mode is known.

## Opportunities

### P1 — Fix `/supi:ui-design` write guard for OMP edit payloads

- **Changelog entries:**
  - 14.2.0 Added: `apply_patch` edit mode.
  - 14.2.0 Changed: Spark models default to `apply_patch` edit mode.
- **Priority:** P1
- **Effort:** Low
- **Impact:** UI-design sessions block `edit` calls before path validation can succeed. This is a pre-existing mismatch, but the Spark default change makes it more likely that agents use edit/apply-patch semantics.
- **Evidence:**
  - `src/ui-design/session.ts:767-772` treats `write`, `edit`, and `ast_edit` the same and returns `input.path`.
  - `src/ui-design/session.ts:799-808` blocks a write tool call when the resolved candidate path is empty: `cannot verify ${event.toolName} without a path under ...`.
  - `src/ui-design/session.ts:811-815` correctly enforces that write paths stay inside the UI-design session directory once a path is found.
- **Implementation guidance:** Change only the `edit` branch in `getUiDesignWritePath()` to inspect `input.edits` and return the first edit path. Keep `write` and `ast_edit` on their existing top-level `path` handling unless the OMP AST edit contract is separately shown to differ. Add or update a unit test that simulates `event.toolName === "edit"` with `{ edits: [{ path: sessionDirRelativePath, ... }] }` and verifies it is not blocked.

### P2 — Refresh context-mode `todo_write` fixture for the new API

- **Changelog entry:** 14.1.3 Breaking Changes: `todo_write` removed `ops` request shape.
- **Priority:** P2
- **Effort:** Low
- **Impact:** Test coverage misrepresents the real runtime event payload. The extractor will still store the input object, but the test no longer proves behavior with the actual OMP 14.1.3+ shape.
- **Evidence:**
  - `tests/context-mode/event-extractor.test.ts:144-148` uses `input: { ops: [{ op: "add_task", content: "Fix bug" }] }`.
  - `src/context-mode/event-extractor.ts:95-98` stores `event.input` opaquely, so the fix is fixture-only unless the UI later renders individual operation fields.
- **Implementation guidance:** Replace the fixture with top-level fields such as `add_tasks`, `complete`, or `add_notes`, and assert that a task event is still emitted.

### P2 — Clarify UI-design prompt wording around “apply patches”

- **Changelog entry:** 14.2.0 Added: `apply_patch` edit mode.
- **Priority:** P2
- **Effort:** Low
- **Impact:** Planning mode intentionally prohibits all edits. UI-design mode prohibits production-code edits and writes outside the session directory, but the phrase “apply patches” now overlaps with a concrete OMP edit mode name.
- **Evidence:**
  - `src/planning/system-prompt.ts:99` and `src/planning/system-prompt.ts:191-193` prohibit writing production code or applying patches during planning.
  - `src/planning/system-prompt.ts:221-234` explicitly says `/supi:plan` must not implement code and must write plans under `.omp/supipowers/plans/`, not `local://PLAN.md`.
  - `src/ui-design/system-prompt.ts:249-258` says UI-design must not “implement code, apply patches, or write outside the session directory,” while also requiring artifacts under the session directory.
- **Implementation guidance:** Leave planning wording as-is because no edits are allowed there. In `src/ui-design/system-prompt.ts:250`, clarify the boundary: “Do not edit production code or write outside the session directory; edit tools, including apply_patch, are allowed only for artifacts under `<sessionDir>`.”

### P2 — Document compiled OMP binary `.env` autoload change for MCP bearer auth

- **Changelog entry:** 14.2.0 Fixed: compiled `omp` binaries ignore project-local `bunfig.toml` and `.env` autoloading at startup.
- **Priority:** P2
- **Effort:** Documentation-only
- **Impact:** This runtime fix prevents unsafe project-local preload behavior, but users who relied on compiled OMP autoloading `.env` for MCP bearer tokens may need to export environment variables explicitly.
- **Evidence:**
  - `src/mcp/lifecycle.ts:21-25` reads bearer auth tokens from `process.env[config.auth.envVar]`.
  - `src/mcp/config.ts:207-215` discovers per-server `env` fields, but bearer auth lookup itself is still from process environment.
  - `src/platform/omp.ts:53-54` only merges explicit env overrides for `platform.exec`; it does not affect MCP lifecycle startup.
- **Implementation guidance:** Add a release note or troubleshooting entry: compiled OMP 14.2.0 no longer autoloads project `.env`; MCP bearer token variables must be exported in the shell/OS/CI environment or otherwise provided by the supported MCP configuration path.

### P3 — Decide whether to re-enable inline read previews for guided workflows

- **Changelog entry:** 14.2.0 Changed: inline read tool previews are optional via `read.toolResultPreview` and default to off.
- **Priority:** P3
- **Effort:** Unknown until OMP exposes the setting to extensions
- **Impact:** No structured-output break found. It may reduce visible TUI feedback during `/supi:plan` and `/supi:ui-design` exploration.
- **Evidence:**
  - `src/ai/final-message.ts:61-80` extracts only assistant text from session messages, so read preview rows do not affect final structured outputs.
  - `src/ai/final-message.ts:97-117` handles session prompt success/failure and reads `session.state.messages`; no preview count or preview text is parsed.
  - `src/commands/plan.ts:192-195` and `src/commands/ui-design.ts:360` start interactive turns through `sendUserMessage`, where user-visible tool preview behavior is runtime-controlled.
- **Implementation guidance:** No required code change. If OMP supports per-session or extension-level config for `read.toolResultPreview`, consider enabling it only for `/supi:plan` and `/supi:ui-design` where visible context-gathering feedback is useful.

### P3 — Benefit from `apply_patch` streaming and diagnostics fixes

- **Changelog entries:**
  - 14.2.0 Added: `apply_patch` edit mode.
  - 14.2.0 Fixed: apply-patch streaming previews no longer show the missing `*** End Patch` parse error while content is still arriving.
  - 14.2.0 Fixed: diagnostics rendering replaces tabs before TUI output.
- **Priority:** P3
- **Effort:** None
- **Impact:** Beneficial runtime behavior for agent sessions that edit files.
- **Evidence:**
  - `src/platform/omp.ts:108-119` passes agent-session options through to OMP without forcing an edit mode, so OMP defaults apply.
  - `src/ultraplan/execution/session-runner.ts:157-165` creates headless task-execution sessions and prompts them to execute assignments; these can benefit from better default edit behavior when a Spark model is selected.
- **Implementation guidance:** No action. If a future workflow explicitly depends on non-`apply_patch` edit semantics, set the edit mode explicitly in the agent-session options at that callsite.

## No-Action Compatibility Notes

| Changelog entry | Assessment | Evidence |
|---|---|---|
| `SearchParams.recency` must be a pure time filter | No direct impact; no supipowers source callsite uses web search recency. | Platform APIs in `src/platform/types.ts:116-154` do not include web search; review of source usage found no `SearchParams` handling. |
| Tavily no longer scopes recency searches to news | No direct impact; beneficial only when users/agents invoke OMP web search outside supipowers code. | No supipowers API wrapper for web search exists in `src/platform/omp.ts:47-136`. |
| Edit diff/replace missing-file errors now use `File not found: <path>` | No direct impact found; supipowers checks process exit state rather than parsing edit-tool error text. | `src/quality/runner.ts:81-90` wraps `platform.exec` errors generically and does not inspect OMP edit-tool errors. |
| `local://` Linux path leak fixed | No code change; supipowers prompts explicitly avoid native `local://PLAN.md`. | `src/planning/system-prompt.ts:231-234`; `src/ui-design/system-prompt.ts:255-258`; persisted plan path uses `.omp/supipowers/plans` in `src/planning/approval-flow.ts:264-266`. |
| Darwin compiled binary signing under Bun 1.3.12 | No supipowers package change required. | `package.json:16-18` allows Bun `>=1.3.10`, which includes 1.3.12. |
| Status-line sanitization | Runtime TUI hardening; no source change required. | `src/platform/omp.ts:55-62` sends plain message content and options; no status-line escape handling exists in the adapter. |
| UUIDv7 session IDs | No impact found; agent sessions are opaque handles in the platform adapter. | `src/platform/omp.ts:120-125` exposes `subscribe`, `prompt`, `state`, and `dispose`, not a parsed session ID. |
| `sendMessage`, `sendUserMessage`, `registerCommand`, `registerTool`, `getActiveTools`, `registerMessageRenderer`, `.capabilities`, `createPaths` | No removal or rename in changelog; adapter remains compatible. | `src/platform/omp.ts:50-62`, `src/platform/omp.ts:128-136`, and `src/platform/types.ts:116-154` show simple pass-through wrappers and capability flags. |

## Summary Table

| Cluster | Finding | Impact | Priority | Recommendation |
|---|---|---:|---:|---|
| Breaking: `todo_write` | Production code does not call removed `ops` API; one test fixture does. | Test drift | P2 | Update `tests/context-mode/event-extractor.test.ts` fixture to top-level fields. |
| Breaking: task modes | `task.simple` modes do not intersect current supipowers code. | None | None | No action. |
| Edit/apply-patch | UI-design write guard reads wrong path field for `edit`; Spark `apply_patch` default increases exposure. | Workflow blocker in UI-design edit calls | P1 | Read `input.edits[0].path` for `edit` tool events and test it. |
| Prompt wording | “apply patches” is now ambiguous in UI-design prompt. | Confusing guidance | P2 | Clarify production-code vs session-artifact edits. |
| Runtime env | Compiled OMP no longer autoloads project `.env`; MCP bearer tokens use `process.env`. | User migration note | P2 | Document explicit env export requirement. |
| Read preview | Inline read previews default off. | TUI feedback reduction | P3 | Optionally re-enable for guided workflows if OMP exposes config. |
| Agent sessions | Spark sessions default to `apply_patch`; no API break. | Beneficial/low-risk | P3 | No action unless a future callsite requires another edit mode. |
| Misc runtime fixes | Diagnostics tabs, status sanitization, local URL leak, Tavily recency, binary signing. | No code impact found | None | No action. |
