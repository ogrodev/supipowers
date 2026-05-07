# OMP Changelog Audit — 14.6.3 → 14.7.2

| Field | Value |
|---|---|
| OMP versions analyzed | 14.6.4, 14.6.6, 14.7.0, 14.7.1, 14.7.2 |
| supipowers version | 1.5.3 |
| Audit date | 2026-05-06 |
| Prior audit baseline | 14.6.3 (`.omp/omp-audit-config.json`) |

## Executive summary

**Zero breaking impacts.** The headline change in this range — OMP 14.7.0's switch from `systemPrompt: string` (+ separate `projectPrompt`) to `systemPrompt: string[]` across `before_agent_start`/`getSystemPrompt`/`createAgentSession` — was already absorbed by supipowers ahead of the release: a dedicated `src/platform/system-prompt.ts` adapter (`normalizeSystemPromptBlocks`, `systemPromptText`, `appendSystemPromptBlock`, `prependSystemPromptBlock`) is consumed by every hook and the `createAgentSession` wrapper. The other two breaking entries (`BUILTIN_TOOL_METADATA` removal, `read` `sel` parameter removal) reference symbols supipowers never imports or emits.

Three sets of opportunities are worth picking up:

1. **C1 — Drop legacy 14.6.0 fallbacks.** Six `TODO(omp-14.7)` markers (3 source, 4 test) gate compatibility shims for the 14.6.0 `path`/`pattern` → `paths` rename. OMP 14.7.x is now baseline; the shims and their tests can be removed in lockstep.
2. **O1 — `Working…` spinner fix lands automatically (#927).** Multiple supipowers commands (`/supi:status`, `/supi:doctor`, `/supi:clear`, `/supi:context`, `/supi:memory`, `/supi:config`, `/supi:model`, `/supi:agents`, etc.) return without starting a model turn. Under OMP ≥14.7.2 they no longer leave the spinner stuck. No code change needed; a one-line note in CHANGELOG.md / README is appropriate.
3. **O2 — `pr_create` GitHub op for `/supi:release` and `/supi:fix-pr`.** Both currently shell out to `gh` via `platform.exec`. The new `pr_create` ExtensionAPI op gives a typed return (PR URL + summary) without subprocess parsing. Medium effort, medium win.

Smaller opportunities (`summary` field on registered tools, `buildDirectoryTree`/`buildWorkspaceTree` exports, `tools.elideFileMutationInputs`, `read.summarize.prose`) are recorded below at P3 but are not actionable now.

| ID | Severity | File:Line | What breaks |
|---|---|---|---|
| (none) | — | — | No impact found. |

| ID | Priority | Effort | Benefit |
|---|---|---|---|
| C1 | P2 | XS | Removes ~60 lines of dead compatibility code + 4 obsolete tests. |
| O1 | P3 | XS | Documentation / changelog note that command UX improved at 14.7.2. |
| O2 | P2 | M | Replaces shell-out PR creation with typed ExtensionAPI calls. |
| O3 | P3 | S | Add `summary` field to extension tool registrations for BM25 discovery. |
| O4 | P3 | S | Adopt `tools.elideFileMutationInputs` setting for token savings inside `/supi:ultraplan` execution loops. |
| O5 | P3 | S | Adopt `buildDirectoryTree` / `buildWorkspaceTree` for ui-design context scans. |

---

## Breaking Changes

### B0 — `systemPrompt` API: `string` → `string[]` (no impact, already migrated)

**Changelog (14.7.0 Breaking).**

> Changed session system-prompt APIs to use ordered string block arrays by requiring `buildSystemPrompt`, `CreateAgentSessionOptions.systemPrompt`, `Session.rebuildSystemPrompt`, and extension `before_agent_start`/`getSystemPrompt` hooks to accept and return `systemPrompt: string[]` instead of a plain system-prompt string or separate `projectPrompt` field.

**Status.** Already migrated. supipowers introduced a centralized adapter in `src/platform/system-prompt.ts` that accepts both legacy and new shapes and emits `string[]` outward:

```ts
// src/platform/system-prompt.ts
export function normalizeSystemPromptBlocks(value: unknown): SystemPromptBlocks {
  if (Array.isArray(value)) return value.filter(...);
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  ...
}
export function systemPromptText(value: unknown): string {
  return normalizeSystemPromptBlocks(value).join("\n\n");
}
```

**Coverage** (every site that touches `systemPrompt` has been migrated):

| Site | File:Line | Shape returned |
|---|---|---|
| Agent-session opts | `src/platform/types.ts:51` | `systemPrompt?: string[]` |
| `createAgentSession` adapter | `src/platform/omp.ts:112-114` | `normalizeSystemPromptBlocks(...)` before passing through |
| `/supi:plan` system-prompt hook | `src/planning/system-prompt.ts:271-294` | `return { systemPrompt: [systemPrompt] }` |
| `/supi:ui-design` system-prompt hook | `src/ui-design/system-prompt.ts:290-311` | `return { systemPrompt: [buildUiDesignSystemPrompt(...)] }` |
| MemPalace wake-up hook | `src/mempalace/hooks.ts:34-52, 107` | `appendPrompt(...) → { systemPrompt: string[] }` |
| Harness layer-context inject | `src/harness/hooks/layer-context-inject.ts:123-145` | `prependSystemPromptBlock(...)` returns `string[]` |
| Context-mode hook | `src/context-mode/hooks.ts:851-898` | `return { systemPrompt: [...blocks, injection] }` |
| Active-tool controller | `src/tool-catalog/active-tool-controller.ts:38-99` | `normalizeSystemPromptBlocks(...)` |
| UltraPlan hook bridge | `src/ultraplan/runtime/hook-bridge.ts:467` | `systemPromptText(asRecord(rawEvent)?.systemPrompt)` for read-side |

**Verification.**
- `grep -rn 'projectPrompt' src/ tests/` → **no matches**. supipowers never depended on the now-removed top-level `projectPrompt` field.
- `grep -rn 'buildSystemPrompt|buildDirectoryTree|buildWorkspaceTree|DirectoryTree|WorkspaceTree' src/ tests/` → **no matches**. supipowers does not import OMP's prompt-building helpers.
- Every `before_agent_start` handler in `src/` either returns `undefined` or a record of shape `{ systemPrompt: string[] }`.

**Impact.** None. No follow-up required.

### B1 — `BUILTIN_TOOL_METADATA` and `BuiltinEntry` exports removed (no impact)

**Changelog (14.7.2 Breaking).**

> Removed the exported `BUILTIN_TOOL_METADATA` API, including `BuiltinEntry`-style metadata exports and discoverable-built-in helper exports, which will break consumers relying on those symbols.

**Verification.** `grep -rn -E 'BUILTIN_TOOL_METADATA|BuiltinEntry' src/ tests/` → **no matches**. supipowers does not import or reference these symbols.

**Impact.** None.

### B2 — Top-level `sel` parameter removed from `read` tool schema (no impact)

**Changelog (14.7.0 Breaking).**

> Removed the top-level `sel` parameter from the `read` tool schema, requiring callers to migrate to `path`-embedded selectors (for example `path:50-100`, `path:raw`, or `https://...:L1-L40`).

**Verification.**
- `grep -rn -E 'sel:|"sel"\s*:' src/ tests/` → **no matches** for `read` tool callsites. (False positives for `select`, `session`, `self` were filtered out manually.)
- supipowers does not invoke the `read` tool programmatically; its commands use Node `fs` (`fs.readFileSync`, `fs.readdirSync`) for file IO. The `read` tool is a thing the **agent** calls; supipowers does not synthesize `read` payloads anywhere.
- `skills/context-mode/SKILL.md` (the agent-facing teaching) was already migrated to `path:`-embedded selectors during the 14.5.13 → 14.6.3 audit (B3 in the prior report); no `sel:` examples remain.

**Impact.** None.

### B3 — `buildSystemPrompt` / `rebuildSystemPrompt` return shape changed (no impact)

**Changelog (14.7.0 Breaking).**

> Changed `buildSystemPrompt` and session `rebuildSystemPrompt` APIs to return `{ systemPrompt, projectPrompt }`, requiring callers expecting a plain system prompt string to update to the new shape.

**Verification.** `grep -rn 'buildSystemPrompt\|rebuildSystemPrompt' src/ tests/` → **no matches**. supipowers does not call these top-level OMP factories. The `tool-catalog/active-tool-controller.ts` invokes `ctx.getSystemPrompt()` (the per-session ctx method, not the factory) and feeds the result through `normalizeSystemPromptBlocks` (`src/tool-catalog/active-tool-controller.ts:88, 99`), which already accepts both legacy and new shapes.

**Impact.** None.

---

## Opportunities

### C1 — Drop the OMP 14.6.0 compatibility shims now that 14.7.x is baseline (P2, XS)

**Background.** The previous audit (14.5.13 → 14.6.3) flagged the OMP 14.6.0 rename of `path: string` (comma-delimited) → `paths: string[]` on `search`, `find`, `ast_grep`, and `ast_edit`. Supipowers landed dual-shape readers in two places to keep workflows alive across the upgrade window, each annotated with a `TODO(omp-14.7)` marker:

| Site | File:Line | Shim |
|---|---|---|
| ui-design write guard for `ast_edit` | `src/ui-design/session.ts:772-783` | Reads `input.paths` (new) first, falls back to comma-split `input.path` (legacy). |
| Context-mode dedup hash for `search` | `src/context-mode/source-hash.ts:126-144` | Reads `input.paths` (new), falls back to single-element `[input.path]` (legacy). |
| Context-mode dedup hash for `find` | `src/context-mode/source-hash.ts:145-160` | Reads `input.paths` (new), falls back to single-element `[input.pattern]` (legacy). |

**Status.** Six markers remain (`grep -rn 'TODO(omp-14.7)' src/ tests/`):
- `src/ui-design/session.ts:776`
- `src/context-mode/source-hash.ts:128`
- `src/context-mode/source-hash.ts:148`
- `tests/ui-design/session.test.ts:375`
- `tests/ui-design/session.test.ts:385`
- `tests/context-mode/source-hash.test.ts:245`
- `tests/context-mode/source-hash.test.ts:273`

**Recommendation.** OMP 14.7.x is the new floor; drop the legacy branches and matching tests. Concretely:

1. `src/ui-design/session.ts:772-783` — collapse to read only `input.paths`:
   ```ts
   case "ast_edit": {
     const arr = Array.isArray(input.paths)
       ? (input.paths as unknown[]).filter((p): p is string => typeof p === "string")
       : [];
     return arr.length === 0 ? [""] : arr;
   }
   ```
2. `src/context-mode/source-hash.ts:126-160` — drop the `input.path` / `input.pattern` legacy branches in both `search` and `find` cases. The empty-paths fallback can stay defensive but should no longer try to synthesize a list from old field names.
3. `tests/ui-design/session.test.ts:375-394` — delete the two `TODO(omp-14.7)`-tagged tests that pin legacy comma-string behavior.
4. `tests/context-mode/source-hash.test.ts:245-285` — delete the two `TODO(omp-14.7)`-tagged tests that pin the legacy fallback.

**Effort.** XS. Mechanical, scoped to four files. Run `bun test tests/ui-design/session.test.ts tests/context-mode/source-hash.test.ts` afterwards.

**Risk.** Bumps the minimum supported OMP version (de facto already 14.7+). Document in `CHANGELOG.md` and the install README.

### O1 — Document the spinner fix; verify in-tree commands no longer hang the TUI (P3, XS)

**Changelog (14.7.2 Fixed).**

> Fixed extension commands that return without starting a model turn leaving the interactive `Working…` spinner active indefinitely. (#927)

**Why this matters for supipowers.** Many supipowers commands intentionally short-circuit without sending a user message or steering the agent. Each was previously triggering the bug:

| Command | File | Pattern that hits the bug |
|---|---|---|
| `/supi:status` | `src/commands/status.ts` | Renders summary via `ctx.ui.notify`; never calls `sendUserMessage`/`sendMessage`. |
| `/supi:doctor` | `src/commands/doctor.ts` | Reports check results to TUI; no model turn. |
| `/supi:clear` | `src/commands/clear.ts` | Destructive cleanup with confirm prompt; returns without a turn on cancel **and** on success. |
| `/supi:context` | `src/commands/context.ts` | Computes context-window breakdown and prints; no model turn. |
| `/supi:memory` | `src/commands/memory.ts` | `setup` / `status` subcommands return after running `mempalace` actions. |
| `/supi:config`, `/supi:model`, `/supi:update` | resp. files | Configuration helpers; no model turn. |
| `/supi:agents` (list / show subcommands) | `src/commands/agents.ts` | Read-only paths return without `sendMessage`. |

(Only commands that always trigger a turn — `/supi:plan`, `/supi:qa`, `/supi:fix-pr`, `/supi:ui-design`, `/supi:commit`, `/supi:release`, `/supi:generate` — never hit the bug.)

**Recommendation.** No code change. Record the user-visible improvement in `CHANGELOG.md` for the next supipowers release ("Requires OMP ≥14.7.2 to avoid stuck `Working…` spinner after read-only commands"). Optionally bump the README's recommended OMP version line.

**Effort.** XS — one CHANGELOG line and one README line.

### O2 — Adopt the new GitHub `pr_create` op in `/supi:release` and `/supi:fix-pr` (P2, M)

**Changelog (14.7.1 Added).**

> Added `pr_create` operation to the GitHub tool to create pull requests with title/body (or `fill`), base/head branch, draft, reviewer, assignee, and label options and return a summarized result including the new PR URL.

**Current state.** supipowers shells out to `gh` via `platform.exec` for all GitHub interactions:
- `src/git/commit.ts` — uses `platform.exec` to run `git`/`gh` (PR-related metadata via subprocess).
- `src/release/` — `platform.exec` for tag pushes and gist/PR creation.
- `src/fix-pr/fetch-comments.ts` — `platform.exec` for `gh pr view`.
- `src/commands/release.ts`, `src/commands/fix-pr.ts` — orchestrate the above.

There is no use of OMP's `github` ExtensionAPI tool family in production code (`grep -rn 'pr_create|gh_pr|pr_view|pr_diff' src/` → **no matches**). Today's `gh` shell-out path works but:
- Couples supipowers to the user's `gh` CLI installation and auth.
- Requires bespoke stdout parsing (`gh pr view --json …`) that drifts when `gh` updates its JSON shape.
- Doesn't surface a typed PR URL to the caller; we re-grep the URL out of `gh pr create`'s stdout.

**Recommendation (P2).** Wrap the `pr_create` op behind an internal `createPullRequest({ title, body?, base?, head?, draft?, reviewers?, assignees?, labels? })` helper in `src/git/` (alongside `commit.ts`), then refactor:

1. `/supi:release` — when the release flow finishes a tag push and the user opted in to "open a PR", call the helper instead of building a `gh pr create` argv. The helper returns `{ url, summary }`.
2. `/supi:fix-pr` — currently the consumer of an existing PR; if the workflow ever needs to *create* a follow-up PR (e.g. "draft a docs PR with these changes"), use the helper.

Wire the helper to a feature gate so users on OMP <14.7.1 keep the `gh` shell-out fallback for one release window.

**Effort.** Medium. ~150–250 lines: helper + adapter call + integration tests + feature gate. Touches `src/git/`, `src/release/`, `src/commands/release.ts`, plus tests under `tests/release/` and `tests/git/`.

**Acceptance.** Helper returns the PR URL; release command stops parsing `gh` stdout; existing tests for the shell-out path are migrated to the helper. Document the OMP version requirement in the helper.

### O3 — Add a `summary` field to extension tool registrations (P3, S)

**Changelog (14.7.2 Changed).**

> Updated discoverable tool search (`search_tool_bm25` and related discovery metadata) to read each tool's own `summary` field when present, improving discoverability descriptions for built-in tools.

**Current state.** supipowers registers ten tools (per `bootstrap.ts` and the tool source files). None set a `summary` field; they expose `description` (long form) and, for some, `promptSnippet` (one-liner used in prompt sections):

| Tool | File | Has `description` | Has `promptSnippet` | Has `summary` |
|---|---|---|---|---|
| `planning_ask` | `src/planning/planning-ask-tool.ts:21-24` | ✓ | ✓ | ✗ |
| `mempalace` | `src/mempalace/tool.ts` | ✓ | — | ✗ |
| `harness_*` (7 tools) | `src/harness/tools.ts` | ✓ | — | ✗ |
| `ultraplan_*` (authoring + execution) | `src/ultraplan/authoring/authoring-tools.ts`, `src/ultraplan/execution/runtime-tools.ts`, `src/ultraplan/authoring-tool.ts` | ✓ | — | ✗ |
| context-mode tools (`ctx_*`) | `src/context-mode/tools.ts` | ✓ | — | ✗ |

**Why this is small.** Most of these tools are gated to specific lifecycle moments (e.g., `harness_*` only matters during a `/supi:harness` session) and the agent already sees them in the active tool list with their full descriptions. The `summary` field primarily helps when a tool is **inactive** and the agent searches for it via BM25 — a path most supipowers tools don't take because they're enabled context-by-context.

**Recommendation (P3).** Pass-by-pass, when touching each tool definition for an unrelated reason, append a one-line `summary` (≤80 chars) crafted to match the BM25 query patterns the agent would use. Example for `planning_ask`:

```ts
summary: "ask user during /supi:plan with no timeout (vs. built-in ask)",
```

No urgency. Track as a chore.

**Effort.** Small per tool. Total ~10 lines across the catalog.

### O4 — Opt into `tools.elideFileMutationInputs` for ultraplan execution token savings (P3, S)

**Changelog (14.7.0 Added).**

> Added `tools.elideFileMutationInputs` setting to optionally elide large `write`, `edit`, and `apply_patch` payloads in history after successful mutations.
> Added hashline-style return data for elided `write` calls so tools can include the resulting file content without leaking full input text.

**Why supipowers cares.** `/supi:ultraplan execute` runs long agent loops that frequently rewrite files (`write`/`edit`). On long sessions the mutation inputs accumulate in history and dominate the context window. This setting is opt-in at the OMP `settings.json` level, but supipowers can encourage it.

**Current state.** No reference to this setting in `src/`. supipowers does not replay tool inputs from history (verified earlier: `event-extractor.ts` and `compressor.ts` consume `tool_call` events at emit time, not retroactively from JSONL), so enabling the setting would not break anything in supipowers' own pipelines.

**Recommendation (P3).** In the `/supi:doctor` summary, when running on OMP ≥14.7.0, surface a one-line tip ("Consider `tools.elideFileMutationInputs: true` for long ultraplan runs"). Optional follow-up: in the `quick-setup` skill or installer, prompt the user once. **Do not** flip the setting silently.

**Effort.** Small. One block in `src/commands/doctor.ts` near the existing settings-related checks.

### O5 — Replace ad-hoc directory snapshots with `buildDirectoryTree` / `buildWorkspaceTree` (P3, S)

**Changelog (14.7.0 Added).**

> Added `buildDirectoryTree` and `DirectoryTree` exports to generate configurable directory trees with options for depth, entry limits, hidden-file handling, and truncation caps.
> Added `buildWorkspaceTree` and `WorkspaceTree` exports so callers can precompute and pass a workspace context to prompt generation.

**Current state.** supipowers has multiple ad-hoc directory enumerators:
- `src/ui-design/tokens-scanner.ts` — manually walks tailwind config locations.
- ui-design context scans build a curated tree of relevant files.
- `/supi:doctor` and `/supi:status` enumerate `.omp/supipowers/` subdirs.

None import OMP's new helpers (`grep` confirmed: no matches).

**Recommendation (P3).** When next refactoring ui-design context scans (currently ~kicks off via `src/ui-design/backend-adapter.ts` and friends), evaluate `buildDirectoryTree` / `buildWorkspaceTree` as a drop-in for the bespoke enumerator. The OMP versions handle truncation, hidden files, and entry caps consistently.

**Effort.** Small per use-site. Primarily a code-quality / consistency win.

---

## Other changelog entries reviewed and dismissed

| Entry | Status | Why no impact |
|---|---|---|
| 14.7.2 — SearXNG Basic Auth validation (Fixed) | No impact | supipowers does not configure SearXNG auth. |
| 14.7.2 — `authHeader: true` Authorization fix #929 | No impact | supipowers does not register custom providers with `authHeader`. |
| 14.7.1 — `read.summarize.prose` setting (Added) | No impact | Affects how the agent's `read` output looks; supipowers reads files via `fs`, not via the agent tool. |
| 14.7.1 — `PI_GREP_WORKERS` doc (Changed) | No impact | Env var documentation; supipowers does not set or read `PI_GREP_WORKERS`. |
| 14.7.1 — Hashline auto-absorb broadening (Changed) | No impact | Affects the `edit` tool's anchor-handling for the agent; supipowers does not generate hashline payloads. |
| 14.7.0 — `read.summarize.enabled`/`minBodyLines`/`minCommentLines` (Added) | No impact | Same rationale as `read.summarize.prose` — agent-tool behavior. |
| 14.7.0 — `edit.hashlineAutoDropPureInsertDuplicates` (Added) | No impact | Edit-tool behavior. |
| 14.7.0 — Project prompt as leading `developer` message (Changed) | No impact | supipowers reads `event.systemPrompt` (or `ctx.getSystemPrompt()`) — neither field is the developer message. We do not introspect the developer-message channel. |
| 14.7.0 — `read` directory two-level recency-sorted tree (Changed) | No impact | Agent-tool rendering only. |
| 14.7.0 — Working-directory tree block in system prompt (Changed) | No impact | The block is appended by OMP; supipowers preserves existing system-prompt content via the array-block API. |
| 14.7.0 — `read` summary `..` boundary merging (Changed) | No impact | Agent-tool rendering. |
| 14.7.0 — Default `read` returns structural summary (Changed) | No impact | supipowers reads files with `fs`, not the agent `read` tool. |
| 14.7.0 — Truncation/pagination hints colon syntax (Changed) | No impact | UI-only change. |
| 14.7.0 — Selector parsing fix for colon-containing paths (Fixed) | No impact | Bug fix benefits the agent; no supipowers callsite passes such paths. |
| 14.7.0 — Hashline pure-insert duplicate auto-drop opt-in (Changed) | No impact | Edit tool behavior. |
| 14.6.6 — Ctrl+D draft persistence (Added) | No impact | TUI-only feature. |
| 14.6.4 — Hindsight `mental_models` system, `/memory mm` commands (Added/Changed/Fixed) | No impact | supipowers does not depend on Hindsight memory; MemPalace is the memory backend (`src/mempalace/`). The two systems are independent. |
| 14.6.4 — Hashline replacement boundary auto-absorb warnings (Added) | No impact | Edit-tool behavior. |
| 14.6.4 — Subagent `/task` parent-bank persistence fix | No impact | Hindsight-specific. |

---

## Verification commands

The following commands can be used to re-verify the audit conclusions:

```bash
# B0 — every before_agent_start handler returns array shape (or undefined)
grep -rn 'before_agent_start' src/

# B0 — no projectPrompt usage
grep -rn 'projectPrompt' src/ tests/

# B1 — no BUILTIN_TOOL_METADATA imports
grep -rn -E 'BUILTIN_TOOL_METADATA|BuiltinEntry' src/ tests/

# B2 — no `sel:` parameter in read tool calls
grep -rn -E '"sel"\s*:' src/ tests/

# B3 — no buildSystemPrompt / rebuildSystemPrompt callsites
grep -rn -E 'buildSystemPrompt|rebuildSystemPrompt' src/ tests/

# C1 — remaining 14.7 cleanup TODOs
grep -rn 'TODO(omp-14.7)' src/ tests/

# O2 — current GitHub tool usage in production
grep -rn -E 'pr_create|gh_pr|pr_view|pr_diff' src/

# O3 — tools registered without summary field
grep -rn -E 'registerTool\(|name:' src/context-mode/tools.ts src/planning/planning-ask-tool.ts src/mempalace/tool.ts src/harness/tools.ts src/ultraplan/authoring/authoring-tools.ts src/ultraplan/execution/runtime-tools.ts src/ultraplan/authoring-tool.ts
```

---

## Summary table

| Category | Count |
|---|---|
| Breaking changes affecting supipowers | **0** |
| Breaking changes verified non-impacting | 4 (B0, B1, B2, B3) |
| Cleanup opportunities (P2) | 2 (C1, O2) |
| Polish opportunities (P3) | 4 (O1, O3, O4, O5) |
| Changelog entries reviewed and dismissed | 18 |

**Required follow-ups before next OMP upgrade:** none.
**Recommended follow-ups during normal maintenance:** C1 (drop legacy 14.6 shims) and O2 (`pr_create` adoption).
