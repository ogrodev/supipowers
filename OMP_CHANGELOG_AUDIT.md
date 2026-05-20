# OMP Changelog Audit — 15.1.3 → 15.1.7

| Field | Value |
| --- | --- |
| OMP range analyzed | 15.1.3 → 15.1.7 |
| supipowers version | 2.2.2 |
| Audit date | 2026-05-19 |
| Previous audit | 15.1.0 → 15.1.3 (2026-05-17) |

> Evidence convention: every code claim cites `file:line` or `file:line-line` from the inspected source.

## Audit scope

Primary OMP API surfaces inspected:

- Central adapter and type contract: `src/platform/omp.ts:48-150`, `src/platform/types.ts:45-160`.
- Agent-session call paths: `src/ai/final-message.ts:96-136`, `src/context-mode/hooks.ts:251-298`, `src/ultraplan/execution/session-runner.ts:157-167`, `src/git/commit.ts:401-418`.
- Message handoff call paths: `src/commands/qa.ts:398-405`, `src/commands/fix-pr.ts:521-528`, `src/commands/ultraplan.ts:1458-1465`, `src/harness/hooks/post-session-sweep.ts:111-119`, `src/ui-design/session.ts:754-799`.
- Tool registration call paths: `src/planning/planning-ask-tool.ts:24-55`, `src/context-mode/tools.ts:453-500`, `src/harness/tools.ts:124-133`.
- Exec call paths and wrappers: `src/platform/omp.ts:11-17`, `src/platform/omp.ts:56-57`, `src/utils/exec-cli.ts:7-30`, `src/commands/ultraplan.ts:710-729`, `src/fix-pr/fetch-comments.ts:111-129`, `src/fix-pr/fetch-comments.ts:220-246`.
- Planning approval and ask isolation: `src/planning/system-prompt.ts:223-241`, `src/planning/approval-flow.ts:314-331`, `src/planning/approval-flow.ts:431-463`, `src/storage/plans.ts:12-24`.

## Breaking Changes

### Verdict: no hard breaking changes found

No OMP 15.1.4–15.1.7 changelog entry removes or renames an API that supipowers 2.2.2 directly imports or calls. Two items are worth tracking as compatibility risks because they sit near critical workflows, but neither requires an immediate migration.

### Compatibility risk: `/supi:plan` native `resolve` guard is narrower than the 15.1.6 malformed-title fix

**Changelog entry:** 15.1.6 fixed native plan-mode `resolve` loops when `extra.title` is not a usable string.

**Impact.** Supipowers intentionally does not use native OMP plan approval in `/supi:plan`; it relies on a file watcher, schema validation, reliability logging, and a custom approval UI. The planning prompt says this is not native OMP plan mode, forbids `resolve` with `extra.title`, forbids `local://PLAN.md`, and requires saving to the supipowers plan directory (`src/planning/system-prompt.ts:233-240`). The approval hook then detects new plan files by filename delta (`src/planning/approval-flow.ts:314-331`) and presents `ctx.ui.select` approval options (`src/planning/approval-flow.ts:431-443`).

The runtime guard currently blocks only `resolve` calls whose input has `action: "apply"` and a string `extra.title` (`src/planning/planning-ask-tool.ts:130-138`, `src/planning/planning-ask-tool.ts:152-160`). Because OMP now accepts/falls back for malformed `extra.title`, a mistaken `resolve({ action: "apply", extra: { title: {} } })` would not match our guard. Normal `/supi:plan` should not have an OMP-native pending action to resolve, so this is not a confirmed break.

**Recommendation.** Harden the guard in a follow-up: while `isPlanningActive()` is true, block every `resolve` call with `action: "apply"`, not just the string-title native shape. Add a narrow unit test for string, object, missing, and non-apply inputs.

### Compatibility risk: ACP command/custom-tool argument preservation is now fixed upstream, but these paths depend on preserved raw inputs

**Changelog entry:** 15.1.4 fixed ACP command and custom tool-call notifications to carry original tool arguments in replayed/final updates.

**Impact.** Supipowers command semantics use direct handler args, not ACP notification payloads. The OMP adapter forwards command registration unchanged (`src/platform/omp.ts:51-52`), `/supi:plan --quick` parses the raw command string (`src/commands/plan.ts:79-83`), and `planning_ask` receives structured params directly in its execute callback (`src/planning/planning-ask-tool.ts:56-63`). Custom tools are forwarded without local wrapping (`src/platform/omp.ts:135-135`). This is an upstream reliability fix, not a local API break.

**Recommendation.** Keep on the smoke-test list after OMP upgrades: `/supi:plan --quick <text with spaces/punctuation>` and one `planning_ask` call. No source change required.

### No-impact entries

| Changelog entry | Impact | Evidence | Recommendation |
| --- | --- | --- | --- |
| 15.1.7 `debug` launch/attach fixes and directory-valued launch rejection | Supipowers does not invoke OMP DAP launch/attach. Its own debug logger is `SUPI_DEBUG` file logging, not OMP `debug`. | `src/debug/logger.ts:19-24`, `src/debug/logger.ts:36-52`, `src/platform/types.ts:45-55`, `src/platform/omp.ts:101-133` | No migration. |
| 15.1.7 hashline edit payload warning | Runtime code does not construct hashline `edit` payloads. Planning mode forbids implementation edits and only tells agents to save plan markdown. | `src/planning/system-prompt.ts:193-218`, `src/planning/system-prompt.ts:223-241`, `skills/context-mode/SKILL.md:64-68` | No runtime migration. Optional docs polish in Opportunities. |
| 15.1.7 ACP bash permission metadata | `Platform.exec` exposes only `cwd`, `timeout`, and `env`; non-env calls delegate to `api.exec`, env calls use `Bun.spawn`. Supipowers does not read ACP permission metadata. | `src/platform/types.ts:66-77`, `src/platform/omp.ts:11-17`, `src/platform/omp.ts:56-57` | No migration. |
| 15.1.7 fast-mode status-line predicate | Supipowers writes its own `supi-model` footer status for model overrides but does not inspect OMP fast-mode state. | `src/config/model-resolver.ts:172-185`, `src/config/model-resolver.ts:187-195`, `src/platform/types.ts:103-115` | Smoke-test status-line coexistence; no code migration unless `ctx.ui.setStatus` semantics change. |
| 15.1.7 scoped `serviceTier` values | Supipowers model config has only `model` and `thinkingLevel`; no service-tier field is persisted or passed. | `src/types.ts:613-626`, `src/config/model-resolver.ts:10-55`, `src/config/model-resolver.ts:130-170`, `src/platform/omp.ts:67-78` | No migration. |
| 15.1.7 provider-agnostic `/fast` | `/fast` remains OMP-owned. Supipowers controls only `setModel` and `setThinkingLevel`. | `src/platform/omp.ts:67-78`, `src/platform/types.ts:146-153`, `src/config/model-resolver.ts:142-170` | No migration. |
| 15.1.5 `ast_grep` / `ast_edit` `parseErrors` cap | Supipowers does not post-process native AST tool `parseErrors`. Its `parseErrors` usage in doctor is config parsing, not OMP AST results. | `src/platform/omp.ts:135-148`, `src/context-mode/tools.ts:453-458`, `src/commands/doctor.ts:76-80` | No migration. |
| 15.1.4 `normalizePlanTitle` spaces/punctuation | Supipowers does not use native plan title normalization. It watches `.md` files under its own plans directory. | `src/planning/system-prompt.ts:233-238`, `src/storage/plans.ts:12-24`, `src/planning/approval-flow.ts:318-331` | No migration. |
| 15.1.4 built-in `ask` prompt example | `/supi:plan` uses a custom `planning_ask` schema and blocks generic `ask` while planning/UI-design is active. | `src/planning/planning-ask-tool.ts:24-55`, `src/planning/planning-ask-tool.ts:108-149`, `src/planning/system-prompt.ts:230-232` | No migration. |
| 15.1.4 ACP async-job owner scoping/status/deferred turns | Supipowers does not implement ACP job draining. Its agent workers consume OMP agent sessions and dispose them normally. | `src/ultraplan/execution/session-runner.ts:157-167`, `src/ultraplan/batch/worker.ts:17-25`, `src/commands/ultraplan.ts:936-980` | No migration. See Opportunities for future status integration. |
| 15.1.4 edit/write/ast_edit permission behavior | Supipowers prompts may instruct agents to write plan artifacts, but production code does not invoke OMP edit/write/ast_edit APIs directly. | `src/planning/system-prompt.ts:193-218`, `src/planning/system-prompt.ts:233-241`, `src/planning/approval-flow.ts:431-463` | No migration. |
| 15.1.4 session tree selector readability | Supipowers only calls `ctx.newSession()` for plan execution handoff and checks cancellation. It does not use the session tree selector API. | `src/planning/approval-flow.ts:238-247`, `src/planning/approval-flow.ts:253-284`, `src/commands/plan.ts:183-192` | No migration. |

## Opportunities

### P1 — Keep command-driven hidden steer handoffs on `sendMessage(..., triggerTurn: true)`

**Why.** OMP 15.1.4 fixed deferred agent-initiated turns during ACP async-job draining. Supipowers already uses the safer pattern for orchestration commands that persist state before dispatching an agent turn.

**Evidence.** `/supi:qa` creates the E2E ledger before dispatch (`src/commands/qa.ts:371-372`) and sends hidden `supi-qa` content with `{ deliverAs: "steer", triggerTurn: true }` (`src/commands/qa.ts:398-405`). `/supi:fix-pr` persists or initializes a running ledger (`src/commands/fix-pr.ts:413-427`) and sends `supi-fix-pr` the same way (`src/commands/fix-pr.ts:521-528`). UltraPlan authoring uses the same handoff (`src/commands/ultraplan.ts:1456-1465`). The adapter currently forwards `deliverAs` and `triggerTurn` (`src/platform/omp.ts:58-63`).

**Effort.** S.

**Guidance.** Do not replace these flows with `sendUserMessage`. Add a release/support note that OMP ≥15.1.4 is recommended for command-driven agent handoffs.

### P2 — Harden the `/supi:plan` native `resolve` block

**Why.** The 15.1.6 fallback made malformed native plan-title resolution non-looping upstream. That is good for OMP, but our plan-mode policy is broader: native `resolve` should not be used at all during `/supi:plan`.

**Evidence.** Policy: `src/planning/system-prompt.ts:233-240`. Guard: `src/planning/planning-ask-tool.ts:130-138`. Narrow matcher: `src/planning/planning-ask-tool.ts:152-160`. Supipowers approval path: `src/planning/approval-flow.ts:314-331`, `src/planning/approval-flow.ts:431-463`.

**Effort.** S.

**Guidance.** Replace `isPlanApprovalResolveInput` with an apply-shape check that returns true for any object where `action === "apply"`. Keep non-apply `resolve` inputs unaffected. Add unit tests for string title, object title, missing `extra`, missing `title`, and non-apply actions.

### P2 — Future-proof `Platform.sendMessage` for new ACP messaging metadata

**Why.** The 15.1.4 ACP fixes are about preserving command/custom-tool arguments in updates. Supipowers currently reconstructs the send options object and would silently drop future send metadata unless the type and adapter are updated together.

**Evidence.** `SendMessageOptions` has only `deliverAs` and `triggerTurn` (`src/platform/types.ts:81-84`). `createOmpAdapter.sendMessage` forwards only those two keys (`src/platform/omp.ts:58-63`). High-value callers are QA, Fix-PR, and UltraPlan (`src/commands/qa.ts:398-405`, `src/commands/fix-pr.ts:521-528`, `src/commands/ultraplan.ts:1458-1465`).

**Effort.** S when OMP exposes a stable field.

**Guidance.** Do not blindly spread unknown options. When OMP exposes a typed metadata field, add it to `SendMessageOptions`, forward it explicitly, and add adapter unit coverage that the field reaches `api.sendMessage`.

### P2 — Use future in-flight completion status to close orchestration ledgers on dispatch failure

**Why.** OMP 15.1.4 now reports in-flight completions more accurately internally. Supipowers ledgers currently mark work as started/running after dispatch but do not observe whether the triggered turn actually starts and completes.

**Evidence.** QA creates a session and immediately notifies started after `sendMessage` (`src/commands/qa.ts:371-372`, `src/commands/qa.ts:398-411`). Fix-PR initializes `status: "running"` before dispatch (`src/commands/fix-pr.ts:413-427`) and then notifies started (`src/commands/fix-pr.ts:521-535`). UltraPlan batch sets state to `running`, runs supervisor passes, and persists transitions (`src/commands/ultraplan.ts:979-993`). `Platform.sendMessage` has no completion/status hook today (`src/platform/types.ts:81-84`).

**Effort.** M after public API support exists.

**Guidance.** Wait for a public OMP extension API; do not synthesize completion with timers. Once available, extend the platform abstraction and update QA/Fix-PR/UltraPlan ledgers to a blocked/error state if dispatch fails before the orchestrator starts.

### P3 — Add optional exec-operation reason metadata only if OMP exposes it

**Why.** OMP 15.1.7 improves ACP bash permission prompts. Supipowers has several high-impact command paths where a reason string would help if OMP exposes a command metadata field.

**Evidence.** `ExecOptions` currently supports only `cwd`, `timeout`, and `env` (`src/platform/types.ts:66-70`). Non-env exec delegates directly to OMP (`src/platform/omp.ts:56-57`). High-impact calls include `git worktree add` (`src/commands/ultraplan.ts:710-729`) and `gh api` review fetching (`src/fix-pr/fetch-comments.ts:111-129`, `src/fix-pr/fetch-comments.ts:220-246`).

**Effort.** S if OMP exposes the field; none otherwise.

**Guidance.** If OMP adds a stable `description`/`reason`/metadata option for `api.exec`, thread it through `ExecOptions` and annotate destructive or networked operations. Do not add a parallel supipowers permission prompt.

### P3 — Decide deliberately before exposing provider-scoped `serviceTier` in supipowers model config

**Why.** OMP 15.1.7 adds provider-scoped priority tiers and makes `/fast` provider-agnostic. Supipowers per-action model config cannot request those tiers today.

**Evidence.** `ModelAssignment` has only `model` and `thinkingLevel` (`src/types.ts:613-619`), and `ModelConfig` has only `version`, `default`, and `actions` (`src/types.ts:621-626`). Resolution and application return/pass only `model`, `thinkingLevel`, and `source` (`src/config/model-resolver.ts:16-24`, `src/config/model-resolver.ts:142-185`). The OMP adapter exposes `setModel`, `setThinkingLevel`, `getCurrentModel`, and `getModelForRole`, not service-tier controls (`src/platform/omp.ts:67-78`).

**Effort.** M.

**Guidance.** Do nothing unless users ask for per-action fast/priority behavior. If they do, first confirm the public OMP API shape, then extend `ModelAssignment`, `resolveModelForAction`, `resolveAllCandidates`, and `applyModelOverride` together. Keep `/fast` itself documented as OMP-owned.

### P3 — Refresh hashline/edit reference docs if they mention edit payloads

**Why.** OMP 15.1.7 now warns on separator-padding-shaped hashline payload mistakes. Supipowers does not generate edit payloads, but its agent-facing reference docs mention the edit contract.

**Evidence.** Context-mode docs mention OMP read anchors for the edit contract (`skills/context-mode/SKILL.md:64-68`). Runtime `ctx_open_cached` slices cached text and does not synthesize edit anchors (`src/context-mode/tools.ts:880-950`).

**Effort.** S.

**Guidance.** If editing agent docs, add one sentence: do not include `|content` in anchors, do not fabricate anchors, and payload lines must start with `~` immediately followed by intended file content.

### P3 — Update `/supi:doctor` recommendations after an OMP minimum-version bump

**Why.** Doctor recommendations still mention OMP 14.7-era UX fixes only. If the project decides to require or recommend OMP ≥15.1.7, doctor can surface the high-value runtime fixes from this audit.

**Evidence.** Current doctor recommendations are static strings for OMP ≥14.7.0 and ≥14.7.2 (`src/commands/doctor.ts:493-505`).

**Effort.** S.

**Guidance.** After the minimum/recommended OMP version is bumped, add a non-failing tip for OMP ≥15.1.7 covering `/fast` status correctness and ACP command/permission prompt reliability. Do not make it a failing health check unless supipowers has a direct version detector.

## Summary table

| Changelog entry | Breaking impact | Opportunity | Priority | Effort | Primary evidence |
| --- | --- | --- | --- | --- | --- |
| 15.1.7 debug launch/attach fixes | None | None | — | — | `src/platform/omp.ts:101-133`, `src/debug/logger.ts:19-24` |
| 15.1.7 hashline edit payload warning | None | Optional doc refresh | P3 | S | `src/planning/system-prompt.ts:223-241`, `skills/context-mode/SKILL.md:64-68` |
| 15.1.7 ACP bash permission metadata | None | Future exec reason metadata | P3 | S if API exists | `src/platform/types.ts:66-70`, `src/platform/omp.ts:56-57` |
| 15.1.7 fast-mode status-line predicate | Low UI coexistence risk only | Doctor note after version bump | P3 | S | `src/config/model-resolver.ts:172-195`, `src/commands/doctor.ts:493-505` |
| 15.1.7 scoped `serviceTier` values | None | Per-action service tier only if requested | P3 | M | `src/types.ts:613-626`, `src/config/model-resolver.ts:16-24` |
| 15.1.7 provider-agnostic `/fast` | None | Keep `/fast` OMP-owned | P3 | — | `src/platform/omp.ts:67-78` |
| 15.1.6 `resolve.extra.title` fallback | No hard break; guard gap | Broaden `/supi:plan` `resolve` guard | P2 | S | `src/planning/planning-ask-tool.ts:130-160` |
| 15.1.5 AST parse error cap | None | None | — | — | `src/platform/omp.ts:135-148`, `src/commands/doctor.ts:76-80` |
| 15.1.4 `normalizePlanTitle` | None | None | — | — | `src/storage/plans.ts:12-24`, `src/planning/approval-flow.ts:318-331` |
| 15.1.4 built-in `ask` prompt example | None | None | — | — | `src/planning/planning-ask-tool.ts:24-55`, `src/planning/planning-ask-tool.ts:108-149` |
| 15.1.4 ACP command/custom notification args | None | Smoke-test command args/tool params | P2 | S | `src/commands/plan.ts:79-83`, `src/planning/planning-ask-tool.ts:56-63` |
| 15.1.4 async job scoping/status/defer | None | Future ledger status integration | P2 | M | `src/commands/qa.ts:398-411`, `src/commands/fix-pr.ts:521-535`, `src/commands/ultraplan.ts:979-993` |
| 15.1.4 edit/write/ast_edit permission behavior | None | None | — | — | `src/planning/system-prompt.ts:193-218`, `src/planning/approval-flow.ts:431-463` |
| 15.1.4 session tree selector | None | None | — | — | `src/planning/approval-flow.ts:253-284` |
