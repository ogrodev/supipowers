# OMP Runtime Changelog Audit

- **OMP version analyzed:** 14.2.0 → 14.5.0 (changelog entries 14.3.0, 14.4.0, 14.4.1, 14.4.2, 14.4.3)
- **Audit date:** 2026-04-26
- **supipowers version:** 1.5.3
- **Output file:** `OMP_CHANGELOG_AUDIT.md`

## Executive Summary

The 14.2.0 → 14.5.0 range removes or renames a large number of agent-facing tool names and edit primitives, but **supipowers itself almost never invokes those tools directly**. It calls a thin `Platform` wrapper (`createAgentSession`, `sendMessage`, `sendUserMessage`, `registerCommand`, `registerTool`, `getActiveTools`, `registerMessageRenderer`, `paths`, `capabilities`, `exec`) — none of which were changed in this range — and shells out to `gh`/`git` via `platform.exec(...)`, which is unaffected by the agent-side `gh_*` → `github` rename.

The breaking-change exposure was concentrated in **two passive observers** that classify `tool_call` events by `event.toolName` and project durable task events into resume snapshots. Both are addressed by the current compatibility patch:

1. `src/context-mode/event-extractor.ts` and `src/context-mode/compressor.ts` now normalize OMP's canonical `open` reader tool to the internal `read` dispatch key, so file-read tracking, oversized-output compression, rule detection, and skill detection keep working for both `open` and legacy `read` events.
2. `src/context-mode/snapshot-builder.ts:extractTaskContent` now projects the 14.4.0 flat `todo_write` op shape (`replace`, `append`, `start`/`done`/`drop`/`rm`, and 14.4.2 `note`) instead of assuming the removed top-level `ops[].content` field.

Two opportunities are worth picking up separately:

- **`/btw` and `irc`** (14.4.3): supipowers does not yet wire any agent-to-agent messaging into review/QA pipelines; the `irc` tool is a low-effort lever for `/supi:fix-pr`-style multi-agent coordination.
- **`shellMinimizer` settings** (14.3.0) and the `artifact://` raw-output footer overlap in goal with `supi-context-mode`. We should at minimum stop fighting OMP's minimizer (or document the interaction) so they don't both shrink the same output twice.

Everything else in the range is either invisible to supipowers (LSP `taplo` default, hashline anchor format, atom edit verb renames, ast_edit/grep schema reshapes, `gh_*` rename, `poll`/`cancel_job` merge, `apply_patch` fixes, chunk-mode removal) or already covered by existing code paths.

## Breaking Changes

### 1. `read` → `open` tool rename

- **Changelog entry:** 14.3.0 Changed: "Changed the canonical file/URL reader tool from `read` to `open` across default tool lists and routing... including ACP mapping, session observers, and streaming message groups". Legacy `read` still works as an alias.
- **Priority:** **Resolved in this patch** — compatibility coverage required for `/supi:context-mode`.
- **Impact:** Without normalization, canonical `open` events would miss file/rule/skill extraction and read-output compression. The current implementation routes both names through `canonicalToolName(...)` and keeps the internal op string as `read`, preserving the existing storage vocabulary.
- **Evidence:**
  - `src/context-mode/tool-name.ts` maps `open` to `read` for internal dispatch.
  - `src/context-mode/event-extractor.ts` switches on `canonicalToolName(event.toolName)` and still emits `file{op:"read"}` events.
  - `src/context-mode/compressor.ts` switches on `canonicalToolName(event.toolName)` for structural compression and LLM summarization prompts.
  - `tests/context-mode/event-extractor.test.ts`, `tests/context-mode/compressor.test.ts`, and `tests/context-mode/hooks.test.ts` include canonical `open` coverage while preserving legacy `read` coverage.
  - `skills/context-mode/SKILL.md` now describes OMP's native `open/read` tool and the 14.4.1 `120th|content` anchor shape.
- **Recommendation:** No further action for this audit item unless OMP removes the legacy `read` alias entirely, at which point supipowers should keep the internal `read` vocabulary or run a storage migration deliberately.

### 2. `todo_write` flat ops reshape

- **Changelog entry:** 14.4.0 Breaking: `todo_write` changed from multi-field verb payloads to an ordered array of flat operations. 14.4.2 added a `note` op.
- **Priority:** **Resolved in this patch** — passive context-mode session knowledge needed projection updates.
- **Impact:** Old projection logic assumed `input.ops[].content`, which is absent from 14.4.0 flat ops. The current implementation reads task content from `replace.phases[].tasks[].content`, `append.items[].label`, `note.text`, and task/phase targets for lifecycle operations.
- **Evidence:**
  - `src/context-mode/snapshot-builder.ts:extractTaskContent` projects the current flat op shapes with the existing 100-character bound.
  - `tests/context-mode/snapshot-builder.test.ts` covers `replace`, `append`, `note`, `start`, `done`, `drop`, `rm`, malformed input, and missing task content.
  - `tests/context-mode/event-extractor.test.ts` uses a realistic flat `ops` payload for durable task event capture.
- **Recommendation:** Keep legacy persisted task events truthful when possible; older `ops[].content` events should continue to render their stored content rather than falling back to generic targets.

### 3. Hashline anchor format documentation

- **Changelog entries:** 14.4.0 and 14.4.1 changed hashline anchor rendering, ending at the `LINE+ID|content` separator form.
- **Priority:** **Resolved in this patch** — docs-only compatibility update.
- **Impact:** supipowers does not parse, generate, or persist OMP hashline anchors itself; it preserves whatever the read/open tool emits. The context-mode skill now uses `120th|content` as the example anchor format.
- **Evidence:**
  - `skills/context-mode/SKILL.md` describes "OMP's native open/read tool" and gives `120th|content` as the post-14.4.1 example.
  - `src/context-mode/compressor.ts` preserves read/open output lines without depending on a specific anchor separator.
- **Recommendation:** No further action.

### 4. Subagent completion contract: `submit_result` → `yield`

- **Changelog entry:** 14.4.0 Breaking: "Renamed the subagent completion contract from `submit_result` to `yield`, so subagent sessions must now finish with the `yield` tool and the `requireYieldTool` option."
- **Priority:** **None** — no impact found.
- **Impact:** None. supipowers never sets `requireSubmitResultTool` or `requireYieldTool`, never references `submit_result`, and never spawns OMP `task` subagents from headless `createAgentSession` calls. Two prompt strings already use the word "yield" (`src/planning/system-prompt.ts:235`, `src/ui-design/system-prompt.ts:259`), but they are colloquial English ("stop and yield your turn"), not contract names.
- **Evidence:**
  - `src/platform/omp.ts:97-125` — `createAgentSession` wrapper passes options straight through; no completion-tool field is set.
  - All headless callers (`src/quality/runner.ts:204-208`, `src/review/{runner,validator,fixer,multi-agent-runner}.ts`, `src/lsp/bridge.ts:63`, `src/fix-pr/assessment.ts:104`, `src/docs/drift.ts:339-390`, `src/git/commit.ts:343`, `src/commands/{fix-pr,ai-review,release}.ts`, `src/ai/{final-message,structured-output}.ts`) consume the session via `prompt`/`subscribe` and parse the final assistant message; none ever touched the legacy `submit_result` field.
  - `src/ai/final-message.ts:88-91`, `src/ai/structured-output.ts:159-218` — read final message text, no completion-tool dependency.
- **Recommendation:** No action. If a future workflow opts into OMP's enforced subagent contract, set `requireYieldTool: true` (not `requireSubmitResultTool`).

### 5. `gh_*` legacy tool names removed; only `github` remains

- **Changelog entry:** 14.4.1 Breaking: "Replaced the legacy `gh_repo_view`, `gh_issue_view`, `gh_pr_view`, `gh_pr_diff`, `gh_pr_checkout`, `gh_pr_push`, `gh_run_watch`, `gh_search_issues`, and `gh_search_prs` tool names with only `github`."
- **Priority:** **None** — no impact found.
- **Impact:** None. supipowers shells out to the `gh` CLI binary via `platform.exec("gh", [...])`, not via the agent-facing `gh_*` LLM tools. The only places `gh` appears in the source are CLI invocations, doctor checks, and release/fix-pr utilities — none reference the renamed tool catalog.
- **Evidence:**
  - `src/commands/fix-pr.ts:163,176` — `platform.exec("gh", ["repo", "view", ...])`, `platform.exec("gh", ["pr", "view", ...])`.
  - `src/commands/release.ts:238` — `platform.exec("gh", ["auth", "status", ...])`.
  - `src/commands/doctor.ts:172,180` — `platform.exec("gh", ["--version"])`, `platform.exec("gh", ["auth", "status"])`.
  - `src/release/channels/github.ts:1-16` — wraps the `gh` CLI; the `id: "github"` here is supipowers' own release-channel identifier, unrelated to the OMP `github` tool.
  - `src/fix-pr/fetch-comments.ts:110-126,144` — uses `gh api ...` via exec.
  - No prompts or skill markdown reference any `gh_*` tool name.
- **Recommendation:** No action.

### 6. `poll` and `cancel_job` merged into `job` tool

- **Changelog entry:** 14.4.3 Changed: "Merged the `poll` and `cancel_job` tools into a single `job` tool that accepts `poll` and `cancel` arrays."
- **Priority:** **None** — no impact found.
- **Impact:** None. supipowers neither invokes nor renders these tools; it does not background work via OMP's job manager. The only `poll` references in `src/` are unrelated (`@oh-my-pi/...` chokidar transitive dep inside `src/visual/scripts/node_modules`).
- **Evidence:** No matches for `"poll"`, `"cancel_job"`, `jobTool`, or polling references in supipowers source or skills (verified by grep across `src/`, `skills/`, `tests/`).
- **Recommendation:** No action.

### 7. `ast_grep` / `ast_edit` schema reshape

- **Changelog entry:** 14.4.0 Breaking: removed multi-pattern `pat` array; removed `lang`/`glob`/`sel` options; `path` now required (also accepts globs and comma-separated lists); `offset` → `skip`. 14.4.0 also adjusted patch/replace/chunk to accept optional entry paths and a top-level path default.
- **Priority:** **P3** — edge case in UI-design write guard.
- **Impact:** supipowers itself never calls `ast_grep`/`ast_edit` from production code (the agent does, when it sees them in the tool list). The one place we introspect them is the UI-design write guard:
  - `src/ui-design/session.ts:767-786` — `getUiDesignWritePaths` treats `ast_edit` like `write`: returns `[input.path]` as a single path. With 14.4.0, `path` may be a comma-separated list (`"src/foo.ts,src/bar.ts"`) or a glob (`"<sessionDir>/**/*.tsx"`). The current code feeds the entire string into `resolvePathWithinDir`, which expects a literal file path; it will return `false` for any non-literal input and the guard emits "may only write inside `<sessionDir>`". The block is correct (such writes shouldn't escape the session dir) but the error message becomes misleading for legitimate sessionDir-scoped globs.
- **Evidence:**
  - `src/ui-design/session.ts:770-771` — `case "ast_edit": return [typeof input.path === "string" ? input.path : ""];`
  - `src/ui-design/session.ts:233-?` — `resolvePathWithinDir` (treats input as a literal path).
  - `tests/ui-design/session.test.ts:203` — fires synthetic events with `input` as opaque record; no glob/list cases covered.
- **Recommendation:** Low priority (UI-design agents shouldn't be invoking project-wide `ast_edit` anyway). If touched: split `input.path` on comma/space, expand against `session.dir`, and reject if any expanded path escapes the session dir. Add a test in `tests/ui-design/session.test.ts` that fires `ast_edit` with a comma-separated path list inside the session dir and asserts the guard does not block.

### 8. `atom` edit verb renames (`before`/`after` → `pre`/`post`, `del` removed)

- **Changelog entry:** 14.4.0 Breaking: atom verb renames; range support removed; `del` replaced by `set: []`; field reshapes (set/pre/post require line arrays; `sub` becomes `[find, replace]` tuple).
- **Priority:** **None** — no impact found.
- **Impact:** None. supipowers does not call `atom` mode, does not generate `atom` payloads, and does not parse atom locators. The only matches for the literal word "atom" in source are in `src/visual/scripts/node_modules` (unrelated express deps).
- **Recommendation:** No action.

### 9. Chunk edit mode removed; chunk-aware `read` selectors removed

- **Changelog entry:** 14.4.2 Removed: "Removed the `chunk` edit mode, chunk-aware `read` selectors, chunk-aware `grep` rendering, and the `omp read` chunk CLI subcommand"; removed `read.prosechunks`, `read.explorechunks`, `read.anchorstyle` settings.
- **Priority:** **None** — no impact found.
- **Impact:** None. supipowers neither performs chunk edits nor reads files via chunk selectors. The only `chunk` matches in `src/`/`tests/` are the knowledge-store BM25 chunker (`src/context-mode/knowledge/chunker.ts`) and a test searching the literal token "chunk" — both unrelated to OMP chunk edits.
- **Recommendation:** No action.

### 10. Default `taplo` Language Server entry removed

- **Changelog entry:** 14.4.1 Removed: "Removed the built-in `taplo` Language Server entry from default LSP settings, so TOML files no longer have default TOML server startup."
- **Priority:** **None** — no impact found.
- **Impact:** None. supipowers reads available LSP servers via `getActiveTools()` and does not depend on `taplo` specifically. There are no TOML files that we drive through `lsp diagnostics`. End-users who want TOML diagnostics will need to add `taplo` themselves.
- **Recommendation:** No action.

### 11. Hashline output separator now `LINE+ID|content`; match/context markers `>` / `:`

- **Changelog entry:** 14.4.1 Changed: read/match output formatting.
- **Priority:** **None** — no impact found.
- **Impact:** None. supipowers does not parse OMP's hashline-rendered output; it consumes file content as text and forwards anchors verbatim through `compressor.compressRead`. The new `>` / `:` markers are agent-side decorations.
- **Recommendation:** No action. (Already covered by §3.)

## Opportunities

### O1. Wire `irc` agent-to-agent messaging into multi-agent review/fix-pr/QA flows

- **Changelog entry:** 14.4.3 Added: "`irc` tool for agent-to-agent messaging with `list` and `send` operations, including optional broadcast to `all` and optional suppression of reply waits"; live in-chat rendering of IRC messages; background ephemeral turn so peers can reply while their main loop is busy.
- **Priority:** **P2**.
- **Effort:** Medium (prompt updates + opt-in flag in review-agent config).
- **Impact:** `/supi:review --multi-agent` runs reviewers in parallel via `runWithOutputValidation` (`src/review/multi-agent-runner.ts:82`) but with no cross-agent coordination — duplicate findings are de-duplicated only post-hoc by the consolidator. With `irc`, individual reviewers could check whether a peer already filed a high-confidence finding before re-investigating the same code path; `/supi:fix-pr` could let the assessment agent ping a verification peer mid-stream rather than spawning a child task.
- **Evidence (today's pain points):**
  - `src/review/multi-agent-runner.ts:78-100` — independent agent sessions; consolidation is a separate pass.
  - `src/review/runner.ts:88-95` — single-agent path.
  - `src/fix-pr/assessment.ts:104-?` — single-shot agent session for each comment.
- **Implementation guidance:**
  1. Treat `irc` as an opt-in capability in `.omp/supipowers/review-agents/config.yml` (e.g., per-agent `peerCoordination: true`).
  2. Inject a small prompt block into agents that have `peerCoordination: true` listing peer ids and the IRC etiquette from OMP's tool docs (terse prose, no JSON status payloads, address by id).
  3. Do not introduce a new tool wrapper; the agent calls `irc` directly. supipowers only owns the prompt text and the config flag.
  4. Gate the wiring behind a capability check: `platform.getActiveTools().some(t => t.name === "irc")`. If `irc` is not active (e.g., disabled via OMP's `irc.enabled` setting), keep the agents oblivious — do not advertise the tool in the prompt.
  5. Tests: a multi-agent runner unit test that asserts the IRC prompt block is injected only when the tool is active.

### O2. Honor / coordinate with OMP's `shellMinimizer` settings

- **Changelog entries:**
  - 14.3.0 Added: `shellMinimizer` config (`enabled`, `settingsPath`, `only`, `except`, `maxCaptureBytes`).
  - 14.3.0 Changed: shell execution routes output through the configured minimizer; full original output saved as `bash-original` artifact accessible via `artifact://`.
  - 14.3.0 Added: shell command minimized output appends `[raw output: artifact://<id>]` footer with byte counts.
- **Priority:** **P2**.
- **Effort:** Low (documentation) → Medium (active integration).
- **Impact:** `supi-context-mode` already minimizes bash output in `src/context-mode/compressor.ts:46-70`. With OMP's minimizer also active, oversized bash commands are compressed twice (OMP-side first, then context-mode again), each pass strips information the other might want, and the `[raw output: artifact://...]` footer that OMP adds is preserved by `compressBash` only by accident (it sits in the tail-window). At minimum we should document the interaction; at best we should detect when OMP already minimized and skip our own pass.
- **Evidence:**
  - `src/context-mode/compressor.ts:46-70` — `compressBash` head/tail truncates non-zero exit output; does not detect OMP's prior minimization.
  - `src/context-mode/compressor.ts:88-91` — read compression formats its own omitted-lines marker; not coordinated with OMP minimizer.
  - `skills/context-mode/SKILL.md:53-65` — describes Bash routing rules but does not mention OMP-side minimization or the `artifact://` footer.
- **Implementation guidance:**
  1. Detect OMP's footer pattern in `compressBash`: if the input contains `[raw output: artifact://<id>]`, treat the output as already-minimized and either return it unchanged or apply only a much higher byte threshold.
  2. Add a config field in supipowers `.omp/supipowers/config.json` such as `contextMode.bashMinimizer: "omp" | "supipowers" | "both"`; default to `"omp"` when OMP's minimizer is enabled (which can be detected via the footer or by checking OMP settings on first use).
  3. Update `skills/context-mode/SKILL.md` to mention OMP's minimizer and the `artifact://<id>` footer, and recommend `read` (`open`)-via-artifact when raw output is needed.

### O3. `/btw` empty-prompt and request-replacement fixes — verify supipowers steer pipelines

- **Changelog entries (14.4.3 Fixed):**
  - "Fixed `/btw` handling of empty prompts and missing model configuration by rejecting invalid requests before starting a stream"
  - "Fixed `/btw` request replacement so issuing a new query cleanly aborts the previous active request"
  - "Changed the `/btw` helper to use a session-side ephemeral turn path that preserves streaming-context handling and updates the existing request handling behavior"
- **Priority:** **P3**.
- **Effort:** None (no action required) → Low (defensive validation if we add similar steer paths).
- **Impact:** No direct impact. supipowers uses `platform.sendMessage({ deliverAs: "steer", triggerTurn: true })` for steer-driven workflows (`src/ui-design/session.ts:749-755`, `src/planning/approval-flow.ts`, `src/commands/{plan,qa,fix-pr,mcp,agents,generate}.ts`). These do not use `/btw`. But the fix's underlying ephemeral-turn machinery is now also what `irc` rides on (see O1) and what we may want for any future "ask a peer mid-stream" feature — keep this in mind.
- **Recommendation:** No action. If supipowers later adds an empty/error-path steer, ensure we validate the prompt before sending (the same pattern OMP just adopted).

### O4. Markdown pipe-table `row_N` chunk selectors for plan / docs editing

- **Changelog entry:** 14.3.0 Added: "Added Markdown pipe-table `row_N` chunk selectors for row-level table edits."
- **Priority:** **P3**.
- **Effort:** None — informational.
- **Impact:** Low. `/supi:plan` writes plan markdown via `src/storage/plans.ts` (write-whole-file, not chunk-aware), `/supi:checks` writes JSON, `/supi:release` regenerates `CHANGELOG.md` from git history. No active workflow surgically edits a single Markdown table row. If we ever introduce one (e.g., a "supi audit" report appending a row to a status table), `row_N` chunk selectors are the right primitive — provided chunk edits return; see §9 above (chunk mode itself was removed in 14.4.2, so this opportunity is effectively dead in 14.5.0 unless OMP reintroduces a successor).
- **Recommendation:** No action; flag as obsolete on the next pass.

### O5. `/todo` integration and `note` op for plan execution

- **Changelog entries:**
  - 14.4.2 Added: `note` op on `todo_write`; `/todo` slash command (`edit`, `copy`, `start`, `done`, `drop`, `rm`, `append`, `replace`); `/todo edit` opens in `$EDITOR`; `/todo copy` to clipboard; `/todo export <path>`; `/todo import <path>`.
  - 14.4.2 Changed: `/todo start|done|drop|rm` resolve targets via fuzzy id/name matching; markdown blockquote support for notes in export/import.
- **Priority:** **P2**.
- **Effort:** Medium.
- **Impact:** `/supi:plan` produces a markdown plan file under `.omp/supipowers/plans/`. The handoff to execution is currently a steer message ("here is the plan, please start"). With `/todo import <path>`, we could load the plan into OMP's native todo tracker as the canonical execution checklist, freeing supipowers from re-rendering todo state. The `note` op (14.4.2) lets us attach per-task follow-up reminders without inflating the plan file.
- **Evidence:**
  - `src/storage/plans.ts:96` — comment "Match both '### 1. Name' and '### Task 1: Name' formats"; the parser already produces a structured task list that maps cleanly onto `todo_write` `replace` ops.
  - `src/planning/approval-flow.ts:103-106` — current generic prose "initialize todo tracking with the task list".
  - `src/context-mode/event-extractor.ts:95-99`, `src/context-mode/snapshot-builder.ts:346-354` — already aware of `todo_write` payloads (but see Breaking §2 above; needs the 14.4.0 op shape fix first).
- **Implementation guidance:**
  1. Land Breaking §2 first so the projection understands flat ops with `phases[].tasks[].content`.
  2. After approval in `src/planning/approval-flow.ts`, emit a single steer message that issues a `todo_write` with `op: "replace"` carrying the parsed plan phases/tasks. Optionally include `op: "note"` entries for any rich criteria the parser captured.
  3. Optionally support `/supi:plan --import <path>` that calls `/todo import <path>` semantics directly.
  4. Tests: extend `tests/storage/plans.test.ts` to assert the parsed plan can be projected into a valid 14.4.0 `todo_write` payload.

### O6. `bash-original` artifact for full-output retrieval

- **Changelog entries (14.3.0):**
  - "Added full-output retrieval metadata to minimized shell command output by appending an `artifact://<id>` footer with byte counts"
  - "Fixed bash command minimization to save the full unminimized output as a `bash-original` artifact"
- **Priority:** **P3**.
- **Effort:** Low.
- **Impact:** When `/supi:checks` or QA pipelines run a long command (e.g., a full test suite), supipowers stores its own truncated output. With OMP's `artifact://`, we could persist the artifact id alongside the report so a follow-up agent can fetch the full bytes on demand without repeating the run.
- **Evidence:**
  - `src/quality/runner.ts:181-208` — `platform.exec(...)` consumer; result is captured into the report.
  - `src/storage/reliability-metrics.ts` (referenced from `src/ai/structured-output.ts:23`) — already persists structured per-run records; could store artifact ids as a sidecar.
- **Implementation guidance:**
  1. After each large `platform.exec`, scan stdout for the `[raw output: artifact://<id>]` footer (added by OMP 14.3.0); if present, attach the id to the report record.
  2. Surface the id in `/supi:checks` output and in QA failures so the user (or a follow-up review agent) can `read artifact://<id>` to inspect raw output.

### O7. Live IRC rendering & `job`-tool consolidation — passive benefits

- **Changelog entries:** 14.4.3 (live IRC chat rendering), 14.4.2 (TUI poll renderer + live progress + duration fixes), 14.4.3 (`poll`/`cancel_job` merged into `job`).
- **Priority:** **None** — no action required.
- **Impact:** Beneficial UI/runtime improvements that supipowers does not need to opt into. Reviewers/QA agents that already use `job`-style waiting in their own prompts will get nicer rendering automatically.
- **Recommendation:** No action.

## No-Action Compatibility Notes

| Changelog entry | Assessment | Evidence |
|---|---|---|
| 14.3.0 `apply_patch` streaming/diagnostic fixes | Beneficial; supipowers passes session opts through unchanged | `src/platform/omp.ts:97-125` — no edit-mode override |
| 14.3.0 `replace: { old, new }` chunk op removed | Not used | No matches in `src/`/`tests/` for chunk replace |
| 14.3.0 `read: true` chunk op removed | Not used | Same |
| 14.3.0 chunk path/error guidance fixes | No impact | No chunk callers |
| 14.3.0 streaming preview cancellation, mode-aware diff previews | Beneficial; UI-only | n/a |
| 14.3.0 `models` provider transport overrides preserve runtime headers | No supipowers code touches OMP provider transport directly | `src/config/model-resolver.ts` (not in scope of this audit) writes provider config through the host |
| 14.3.0 SQLite `read` `where=` injection guard | No impact | supipowers does not query its sessions DB via OMP read selectors |
| 14.3.0 `gh_pr_push` no-metadata fail (#778) | Beneficial; we use `gh` CLI directly, unaffected | `src/commands/release.ts`, `src/commands/fix-pr.ts` — direct `gh` exec |
| 14.3.0 Linux non-contiguous CPU id startup crash (#779) | No impact | supipowers does not call `os.cpus()` |
| 14.3.0 Mermaid fenced rendering on terminals without image protocol (#650) | Cosmetic; no supipowers code | n/a |
| 14.4.0 `between` atom verb, inline file overrides, `set: []` deletion | Not used | no `atom` references in `src/` |
| 14.4.0 hashline `±2` rebase, no-op edit diagnostics, mismatch failure rendering | Beneficial only when supipowers' agents drive edits | n/a |
| 14.4.0 OpenAI image `image_generation` tool | Not used | supipowers does not generate images |
| 14.4.0 status-line Git branch ENFILE/EMFILE fix | Beneficial; runtime-only | n/a |
| 14.4.0 `print mode` errorMessage to stderr | Beneficial; no code change | n/a |
| 14.4.0 `grep` schema simplification (folded `glob`/`type`/context options into path globs and settings) | No impact: supipowers uses its own internal grep/ctx_search routing, not OMP's `grep` tool fields directly | `src/context-mode/routing.ts` redirects agents to `ctx_search` |
| 14.4.0 JSON tree truncation / `intent`/`__partialJson` hidden | UI-only | n/a |
| 14.4.0 `providers.image=auto` tries GPT first | No impact | n/a |
| 14.4.1 `sed` verb on `atom` | Not used | atom not in use |
| 14.4.1 `atom` `loc` parser hyphen/range fixes | Not used | atom not in use |
| 14.4.1 hashline anchor handling with `path:LINEID\| ...` content hint | Not used | supipowers does not author atom locators |
| 14.4.2 chunk mode removal | Already absent from supipowers | §9 of Breaking |
| 14.4.2 `/todo` slash-command suite | Optional integration (see O5) | n/a |
| 14.4.2 grep contextBefore/contextAfter defaults restored | Beneficial; we don't override these | `src/context-mode/routing.ts` redirects, doesn't pass through |
| 14.4.2 live poll progress, poll renderer | UI-only; no consumer | n/a |
| 14.4.3 IRC peer-aware prompts for subagents | Opt-in; see O1 | n/a |
| 14.4.3 `irc.enabled` setting | Not consumed; we capability-check via `getActiveTools()` if we wire O1 | `src/lsp/detector.ts:?` pattern (precedent for capability checks) |
| `createAgentSession`/`sendMessage`/`sendUserMessage`/`registerCommand`/`registerTool`/`getActiveTools`/`registerMessageRenderer`/`paths`/`capabilities` | None of these Platform-API methods changed in this range | `src/platform/omp.ts:47-136`, `src/platform/types.ts:116-154` |

## Summary Table

| # | Cluster | Finding | Direct break? | Priority | Action |
|---|---|---|---|---:|---|
| 1 | `read` → `open` rename (14.3.0) | Resolved: `event-extractor.ts` and `compressor.ts` normalize `open` to the internal `read` dispatch key, with tests and skill wording updated | Was yes (silent) | Resolved | No further action |
| 2 | `todo_write` flat ops (14.4.0) | Resolved: `snapshot-builder.ts` now projects `replace`, `append`, lifecycle ops, and `note` payloads from the flat op shape | Was yes (passive) | Resolved | No further action |
| 3 | Hashline anchor format (14.4.0/14.4.1) | Resolved: `skills/context-mode/SKILL.md` now documents the `LINE+ID|content` shape using `120th|content` | No (docs) | Resolved | No further action |
| 4 | UI-design write guard `ast_edit` (14.4.0) | Resolved: `session.ts` checks comma-separated literal paths individually, blocks globs, and preserves whitespace inside literal paths | No (guard hardening) | Resolved | No further action |
| 5 | Subagent `submit_result` → `yield` (14.4.0) | Not used | No | None | No action |
| 6 | `gh_*` tools removed (14.4.1) | We use `gh` CLI via `platform.exec`, not the agent tools | No | None | No action |
| 7 | `poll`/`cancel_job` → `job` (14.4.3) | Not used | No | None | No action |
| 8 | `atom` verb rename (14.4.0) | Not used | No | None | No action |
| 9 | Chunk edit mode removed (14.4.2) | Not used | No | None | No action |
| 10 | `taplo` LSP default removed (14.4.1) | Not used | No | None | No action |
| O1 | `irc` agent-to-agent messaging (14.4.3) | Multi-agent review/fix-pr could coordinate via `irc` instead of post-hoc consolidation only | n/a | **P2** | Opt-in `peerCoordination` flag; capability-gated prompt block |
| O2 | `shellMinimizer` settings + `artifact://` footer (14.3.0) | supipowers and OMP both minimize bash output; coordinate or document | n/a | **P2** | Detect OMP footer in `compressBash`; add config field; update SKILL.md |
| O3 | `/btw` ephemeral-turn fixes (14.4.3) | Underlying machinery for any future steer-style helpers | n/a | **P3** | No action |
| O4 | Markdown `row_N` chunk selectors (14.3.0) | Killed by 14.4.2 chunk-mode removal | n/a | None | No action |
| O5 | `/todo` integration + `note` op (14.4.2) | Could push `/supi:plan` output into native OMP todos via `/todo import` | n/a | **P2** | Land Breaking §2, then emit `todo_write replace` after plan approval |
| O6 | `bash-original` artifact (14.3.0) | Capture artifact id alongside `/supi:checks` reports | n/a | **P3** | Parse footer; persist id |
| O7 | Live IRC + job-tool consolidation | Passive UI/runtime benefits | n/a | None | No action |
