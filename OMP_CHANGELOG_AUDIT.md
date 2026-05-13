# OMP Changelog Audit — 14.9.8 → 15.0.0

| Field | Value |
|---|---|
| OMP version range analyzed | 14.9.8 → 15.0.0 |
| OMP versions with entries in this range | 14.9.9, 15.0.0 |
| supipowers version | 2.0.2 |
| Audit date | 2026-05-13 |
| Prior audit baseline | 14.9.8 (`.omp/omp-audit-config.json`) |

## Executive summary

No existing supipowers production TypeScript callsite depends directly on a removed OMP 15.0.0 API. The `github` tool removals do not break us because PR/comment workflows use the `gh` CLI through `platform.exec`, and the ACP `omp/*` → `_omp/*` rename does not break us because supipowers registers OMP extension commands/tools but does not call ACP extension methods.

The important work is in compatibility and hardening opportunities unlocked or exposed by OMP 15.0.0:

1. **P1 ACP compatibility gap:** `/supi:plan`, `ui-design`, and `planning_ask` still assume a TUI selector. OMP 15.0.0 makes ACP a first-class runtime, but our approval/question hooks gate on `ctx.hasUI` or silently auto-select defaults.
2. **P2 plan-mode guard:** `/supi:plan` tells agents not to call `exit_plan_mode`, but lacks the runtime guard that `ui-design` already has. OMP 15.0.0 added a more attractive native ExitPlanMode approval path, increasing the chance of accidental misuse.
3. **P2 fix-pr quality:** New `pr://.../diff` reads can give fix-pr assessment/orchestrator agents the full PR diff instead of relying only on GitHub review-comment hunks.
4. **No-action confirmations:** Native OMP now owns MCP management/redaction surfaces, and the installed OMP extension API exposes no `credential_disabled` event to subscribe to.

## Breaking Changes

### B1 — GitHub tool removed `issue_view`, `pr_view`, `pr_diff`, and schema fields

**Changelog entry.** OMP 15.0.0 removed `github` tool ops `issue_view`, `pr_view`, `pr_diff`, plus `issue`, `comments`, `nameOnly`, and `exclude`. Single issue/PR/diff reads moved to `read` with `issue://` / `pr://` URLs.

**Status.** No direct breaking impact.

**Evidence.**

- `src/fix-pr/fetch-comments.ts:110-119` fetches inline review comments with `platform.exec("gh", ["api", "--paginate", ...])`, not with the OMP `github` tool.
- `src/fix-pr/fetch-comments.ts:126-136` fetches PR reviews with another `platform.exec("gh", ["api", "--paginate", ...])` call.
- `src/commands/fix-pr.ts:163` detects the repository with `platform.exec("gh", ["repo", "view", ...])`.
- `src/commands/fix-pr.ts:176` detects the PR number with `platform.exec("gh", ["pr", "view", ...])`; this is the `gh` binary, not `op: "pr_view"`.
- `src/fix-pr/scripts/trigger-review.ts:15-21` posts comments through `runCliCommand("gh", ["api", ...])`.
- `src/git/branch-finish.ts:76` references only surviving `github` op `pr_create`.
- Exact source searches for `issue_view`, `pr_view`, `pr_diff`, and `nameOnly` returned no supipowers source/prose matches.

**Impact.** Existing fix-pr, release, and branch-finish flows continue to work. The removed OMP operations were LLM-callable tool operations; our production code shells out to `gh` or references only `pr_create`.

**Recommendation.** No migration required. Use the new `pr://.../diff` URL family only as a prompt-level improvement for agents (see O5/O6).

---

### B2 — ACP custom extension methods renamed `omp/*` → `_omp/*`

**Changelog entry.** OMP 15.0.0 renamed ACP custom extension methods to `_omp/*` to satisfy the ACP custom-method prefix rule.

**Status.** No direct breaking impact.

**Evidence.**

- `src/platform/omp.ts:48-151` adapts OMP's extension API (`registerCommand`, `on`, `exec`, `sendMessage`, `createAgentSession`, `registerTool`) and does not call ACP JSON-RPC extension methods.
- `src/platform/types.ts:120-160` defines the `Platform` interface; there is no ACP method-dispatch or extension-method client surface.
- `src/bootstrap.ts:89-248` registers commands, tools, hooks, and session lifecycle handlers through the OMP extension API.
- Exact source searches for `omp/` and `_omp/` returned no supipowers source matches.

**Impact.** Supipowers is an OMP extension producer, not an ACP client. The rename affects clients that call OMP ACP extension methods; we do not.

**Recommendation.** No change. If a future editor integration calls ACP extension methods directly, use `_omp/*`.

---

### B3 — Task isolation backend/migration changes in 14.9.9

**Changelog entry.** OMP 14.9.9 added native PAL-backed task isolation modes and migrated `task.isolation.enabled=true` to `task.isolation.mode="auto"`.

**Status.** No direct breaking impact.

**Evidence.**

- `src/config/schema.ts:11-179` defines the complete supipowers config schema; it has no `task.isolation` setting.
- `src/config/defaults.ts:5-100` defines all default config; it has no task-isolation default.
- `src/platform/types.ts:45-55` keeps `AgentSessionOptions` generic but has no first-class isolation field.
- `src/platform/omp.ts:115-126` forwards `createAgentSession` options to OMP with cwd/model/session metadata, not task isolation configuration.
- `src/ultraplan/batch/worktree.ts:57-109` shows supipowers' own UltraPlan batch worktree path/branch preparation, independent from OMP's `task` tool isolation setting.

**Impact.** OMP's task isolation setting applies to the built-in `task` tool. Supipowers' multi-agent flows use `platform.createAgentSession` and, for UltraPlan batches, explicit git worktrees. Existing users' OMP isolation migration is transparent to supipowers.

**Recommendation.** No code or config change. Add a short release-note clarification if users confuse OMP task isolation with UltraPlan's own worktree orchestration.

## Opportunities

### O1 — P1: Make `/supi:plan` approval ACP/no-UI aware

**Changelog entries.** OMP 15.0.0 added `omp acp`, ACP plan mode, ACP command parity, and ClientBridge routing.

**Evidence.**

- `src/planning/approval-flow.ts:314-316` returns early when `!ctx?.hasUI`, before checking for newly written plan files.
- `src/planning/approval-flow.ts:248-303` already has an `executeApproveFlow` fallback that can steer execution in the current session when `newSession` is unavailable.
- `src/commands/plan.ts:184-194` starts plan tracking and sends the planning prompt with `platform.sendUserMessage(prompt)`.
- `omp_source/packages/coding-agent/src/modes/acp/acp-agent.ts:118-146` defines ACP extension UI methods as no-op/undefined selectors, confirming selector-based extension UI is not TUI-equivalent in ACP mode.

**Impact.** In an ACP client, `/supi:plan` can start and write a plan, but the approval hook can skip plan detection entirely because `ctx.hasUI` is false. The existing no-new-session fallback is unreachable because the hook exits before presenting/handling approval.

**Implementation guidance.** Add an explicit non-TUI branch after plan validation:

- Do not silently approve. In no-UI mode, surface the saved plan path and ask for an approval/refinement response through an ACP-compatible path once OMP exposes one to extensions.
- Until such a Platform API exists, fail visibly: cancel plan tracking, notify/steer with the plan path and the exact manual command/user action needed to continue.
- Keep TUI behavior unchanged.

**Effort.** Medium if waiting for/requesting an ACP permission/select Platform API; small for a visible no-UI failure path.

---

### O2 — P1: Make ui-design approval cleanup ACP/no-UI aware

**Changelog entries.** OMP 15.0.0 added ACP command parity, plan mode, richer stop reasons, and ClientBridge routing.

**Evidence.**

- `src/ui-design/session.ts:850-853` registers the `agent_end` approval hook and returns immediately on `!ctx?.hasUI`.
- `src/ui-design/session.ts:842-848` documents that the hook owns terminal-state cleanup and resume/discard decisions.
- `src/bootstrap.ts:127-128` always registers `registerUiDesignApprovalHook(platform)` and `registerUiDesignToolGuard(platform)`.

**Impact.** If ui-design is invoked from ACP/no-UI mode, terminal cleanup and resume/discard handling can be skipped. That can leave the companion/session directory active and gives the user no approval path.

**Implementation guidance.** Add a no-UI branch before the current TUI selector flow. For terminal statuses, run deterministic cleanup. For resume statuses, send a clear steer/follow-up message rather than trying to call `ctx.ui.select`.

**Effort.** Small.

---

### O3 — P2: Add a runtime guard for `exit_plan_mode` during `/supi:plan`

**Changelog entries.** OMP 15.0.0 added "Approve and compact context" to native ExitPlanMode approval.

**Evidence.**

- `src/planning/system-prompt.ts:235-240` says this is not native OMP plan mode and tells the agent not to call `exit_plan_mode` / `ExitPlanMode`.
- `src/planning/planning-ask-tool.ts:114-125` registers a runtime `tool_call` guard for generic `ask`, but not for `exit_plan_mode`.
- `src/ui-design/session.ts:792-802` already blocks `exit_plan_mode` during ui-design sessions.
- `src/planning/approval-flow.ts:314-489` has no equivalent `tool_call` guard for active planning sessions.

**Impact.** Prompt text is not enough. OMP 15.0.0 made native ExitPlanMode more capable and therefore more tempting; if the model calls it during `/supi:plan`, native OMP plan-mode behavior can bypass supipowers' plan-file approval hook.

**Implementation guidance.** Add a `tool_call` guard while `isPlanningActive()` is true:

- block `event.toolName === "exit_plan_mode"`;
- return a truthful reason: `/supi:plan` approval is hook/file driven; save to `.omp/supipowers/plans/...` and stop;
- update `src/planning/system-prompt.ts:236` so it no longer says "it will fail"; say it is the wrong approval path.

**Effort.** Small.

---

### O4 — No action: Native OMP owns MCP URL redaction

**Changelog entries.** OMP 15.0.0 redacted query strings and userinfo from native ACP `/mcp list` output.

**Status.** No supipowers-specific MCP redaction work remains.

**Evidence.**

- `src/mcp/` no longer exists.
- `src/commands/mcp.ts` and the MCP command test suite were deleted with the supipowers MCP manager removal.
- Exact source search for the `"mcp"` string literal now finds only context-mode event categorization/tests and a config-migration regression test; no `/supi:mcp` command, generated MCP README, or MCP URL display surface remains.
- `src/context/tokenignore.ts:6-18` does not need a `.omp/supipowers/mcpc/` entry because supipowers no longer generates that directory.

**Impact.** URL redaction for MCP display/configuration is now native OMP's responsibility. Keeping a supipowers redaction task would point maintainers at deleted files and duplicate OMP-owned behavior.

**Recommendation.** No code change. Re-open only if supipowers introduces a new MCP display or generated-doc surface.

**Effort.** None.

---

### O5 — P2: Teach fix-pr assessment agents to use `pr://.../diff`

**Changelog entries.** OMP 15.0.0 added `pr://<N>/diff`, `pr://<N>/diff/<i>`, and `pr://<N>/diff/all`, backed by a shared cache and fixed quoted-path diff parsing.

**Evidence.**

- `src/fix-pr/fetch-comments.ts:8-12` captures `diffHunk` from GitHub review comments, which is only local comment context.
- `src/fix-pr/assessment.ts:42-64` embeds comments JSONL and tells the assessment agent to read referenced code, but does not mention PR diff reads.
- `src/fix-pr/assessment.ts:56-60` is the current rules block; it is the right insertion point for diff navigation guidance.

**Impact.** Review-comment assessment can miss PR-wide context when a comment's `diffHunk` is insufficient. Reading current file contents is not the same as seeing the PR diff the reviewer saw.

**Implementation guidance.** In `buildAssessmentPrompt`, add a rule such as:

```text
- If a comment's diffHunk lacks context, read the full PR diff with the read tool at `pr://<owner>/<repo>/<prNumber>/diff/all` (changed-file list: `.../diff`). Use this only to decide the verdict; do not edit during assessment.
```

Use `args.repo` and `args.prNumber` to emit the repository-qualified URL: ``pr://${args.repo}/${args.prNumber}/diff/all``.

**Effort.** Extra small.

---

### O6 — P3: Add PR diff navigation to the fix-pr orchestrator prompt

**Changelog entries.** Same `pr://.../diff` additions as O5.

**Evidence.**

- `src/fix-pr/prompt-builder.ts:82-91` builds the session context without a PR diff pointer.
- `src/fix-pr/prompt-builder.ts:101-108` embeds review comments JSONL.
- `src/fix-pr/prompt-builder.ts:155-164` asks the orchestrator to plan affected files and ripple effects.

**Impact.** Lower than O5 because the validated assessment already contains ripple effects, but the orchestrator can still benefit when grouping/applying fixes across files.

**Implementation guidance.** Add one session-context bullet:

```text
- Full PR diff: `pr://<owner>/<repo>/<prNumber>/diff/all`; changed-file list: `pr://<owner>/<repo>/<prNumber>/diff`.
```

**Effort.** Extra small.

---

### O7 — No action: `credential_disabled` is not available in the installed extension API

**Changelog entries.** The proposed cleanup depends on a `credential_disabled` extension event, but the installed OMP extension API/types do not expose that event.

**Status.** Do not subscribe.

**Evidence.**

- `node_modules/@oh-my-pi/pi-coding-agent/package.json` reports installed package version `13.10.1`.
- `node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts:933-980` lists every `ExtensionAPI.on(...)` overload; `credential_disabled` is absent.
- `src/platform/omp.ts:80-99` forwards unknown event names to `api.on(...)`, but forwarding a string does not create a production emitter.
- `src/config/model-resolver.ts:201-203` keeps the real `agent_end` cleanup subscription and intentionally avoids the unsupported event.

**Impact.** Registering `credential_disabled` would be test-only confidence: mocks can call the handler directly, but production OMP has no typed event or observed emitter to dispatch it.

**Recommendation.** Keep `agent_end` cleanup as the supported behavior. Revisit only after OMP ships a typed extension event or documented runtime emitter for credential-disable notifications.

**Effort.** None.

---

### O8 — P3: Preserve stop reasons in structured agent runs

**Changelog entries.** OMP 15.0.0 added richer ACP `StopReason` mapping (`max_tokens`, `refusal`, `cancelled`).

**Evidence.**

- `src/platform/types.ts:57-62` models `AgentSession.state` as only `{ messages: any[] }`.
- `src/platform/omp.ts:127-132` exposes `subscribe`, `prompt`, `state`, and `dispose`, but does not capture a final stop reason.
- `src/ai/final-message.ts:89-123` waits for `session.prompt()` and extracts final assistant text from messages only.
- `src/ai/structured-output.ts:214-219` uses the same invalid-output retry prompt for all failures.

**Impact.** A `max_tokens` stop and a malformed JSON answer collapse into similar retry behavior. For schema-backed workflows, a truncation-specific retry would be more effective than a generic "invalid output" retry.

**Implementation guidance.** Defer until reliability metrics show material `max_tokens`/truncation failures. If needed, extend `AgentSession` with optional stop-reason capture, thread it through `runStructuredAgentSession`, and select a shorter-output retry prompt when the stop reason is `max_tokens`.

**Effort.** Medium.

---

### O9 — P3: Improve ACP file-location metadata for pipeline tools

**Changelog entries.** OMP 15.0.0 improved ACP tool-call `locations` and edit diff metadata.

**Evidence.**

- `src/harness/tools.ts:157-160`, `198-201`, `242-245`, `272-275`, `313-320`, `373-376`, and `483-486` return written artifact paths in result objects.
- `src/ultraplan/authoring/authoring-tools.ts:190-193`, `247-250`, `281-284`, `317-320`, `357-360`, `387-390`, `427-431`, `488-491`, and `527-531` do the same for UltraPlan artifacts.
- These tool schemas generally accept `sessionId` / payload fields, not a `path` argument ACP clients can pre-highlight.

**Impact.** ACP editor clients can follow built-in edit locations, but supipowers pipeline artifact writes are not as discoverable because the path appears only after completion in a result payload.

**Implementation guidance.** Low priority. Consider returning `resource_link` content blocks or a standardized `details.locations` array for successful artifact writes if OMP exposes/consumes result-side locations for custom tools.

**Effort.** Small after OMP result-location support is confirmed.

---

### O10 — Transparent benefits / no-action entries

| Changelog area | Effect on supipowers | Evidence |
|---|---|---|
| `read` markdown rendering, error icon, and raw selector fixes | Transparent quality win for spawned agents reading Markdown docs/skills. | Fix-pr agents are told to read referenced code in `src/fix-pr/assessment.ts:56-60`; skill Markdown is embedded in `src/fix-pr/prompt-builder.ts:111-117`. |
| GitHub search multi-qualifier fix | No direct code impact; we do not construct `search_issues` / `search_prs` / `search_code` calls. | Exact searches for `search_issues`, `search_prs`, `search_commits`, and `search_repos` returned no production source matches. |
| GitHub credential-scoped cache | Transparent for future agent `pr://` reads; not usable by current TypeScript `gh api` comment fetchers. | `src/fix-pr/fetch-comments.ts:110-136` runs two direct `gh api` calls. |
| AuthStorage/ModelRegistry reconciliation in `createAgentSession` and `runSubagent` | Transparent reliability win for all session-spawning workflows. | `src/platform/omp.ts:101-126` delegates session creation to OMP; `src/ai/final-message.ts:93-99` and `src/quality/runner.ts:176-208` route structured workflows through that adapter. |
| ACP fs/terminal ClientBridge routing | Built-in `read`/`write`/`bash` improve under ACP; custom `ctx_execute` remains server-side by design. | `src/context-mode/tools.ts:465-479` and `src/context-mode/tools.ts:621-656` call local `executeCode`, while routing can redirect native `bash` to ctx tools. |
| ACP builtin command parity/current-mode update fixes | Transparent benefit for command dispatch; ACP/no-UI workflow gaps remain O1/O2. | Commands are registered in `src/bootstrap.ts:89-113`; `/supi:plan` kickoff uses `sendUserMessage` in `src/commands/plan.ts:194`. |
| `ctx.shutdown()` fix | No direct code change; supipowers listens for shutdown but does not call `ctx.shutdown`. | `src/bootstrap.ts:237-247` and `src/mempalace/hooks.ts:490` register shutdown listeners. |
| Eval dynamic import / non-cloneable / trailing-empty fixes | Transparent for agents; supipowers does not construct eval cells. | No source match for eval cell markers or dynamic eval construction in production source. |
| `/ssh` parsing/list fixes, `/export` clipboard rejection, ACP MCP OAuth/precedence fixes | Native OMP command/tool behavior; no direct supipowers code dependency. | Supipowers no longer has `src/mcp/` or `/supi:mcp` surfaces; exact source search finds no MCP manager command/docs. |
| GitHub cache permissions | Native OMP cache hardening; no supipowers filesystem path or config dependency. | Supipowers GitHub fetching uses `gh api` direct calls in `src/fix-pr/fetch-comments.ts:110-136`. |

## Summary table

| ID | Severity / Priority | Status | File:Line | What it is | Recommendation |
|---|---:|---|---|---|---|
| B1 | None | No impact | `src/fix-pr/fetch-comments.ts:110-136`, `src/commands/fix-pr.ts:163,176` | Removed GitHub tool view/diff ops. | No migration; we use `gh` CLI, not removed ops. |
| B2 | None | No impact | `src/platform/omp.ts:48-151`, `src/platform/types.ts:120-160` | ACP method rename `omp/*` → `_omp/*`. | No migration; we do not call ACP extension methods. |
| B3 | None | No impact | `src/config/schema.ts:11-179`, `src/ultraplan/batch/worktree.ts:57-109` | Task isolation backend/migration changes. | No migration; OMP task isolation is separate from supipowers sessions/worktrees. |
| O1 | P1 | Actionable | `src/planning/approval-flow.ts:314-316` | `/supi:plan` approval hook is TUI-gated and ACP/no-UI hostile. | Add explicit no-UI/ACP approval behavior. |
| O2 | P1 | Actionable | `src/ui-design/session.ts:850-853` | ui-design approval/cleanup hook is TUI-gated. | Add no-UI cleanup/resume handling. |
| O3 | P2 | Actionable | `src/planning/system-prompt.ts:235-240`, `src/ui-design/session.ts:797-800` | `/supi:plan` lacks runtime guard against native `exit_plan_mode`. | Add `tool_call` guard and update wording. |
| O4 | None | No action | `src/mcp/` deleted, `src/commands/mcp.ts` deleted | Native OMP owns MCP URL redaction; supipowers MCP manager surfaces are gone. | No migration unless a new supipowers MCP display surface is introduced. |
| O5 | P2 | Actionable | `src/fix-pr/assessment.ts:42-64`, `src/fix-pr/fetch-comments.ts:8-12` | Assessment agents lack full PR diff navigation. | Add `pr://<owner>/<repo>/<N>/diff/all` guidance. |
| O6 | P3 | Actionable | `src/fix-pr/prompt-builder.ts:82-91,155-164` | Orchestrator prompt lacks PR diff navigation. | Add one session-context diff URL bullet. |
| O7 | None | No action | `node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts:933-980`, `src/config/model-resolver.ts:201-203` | Installed OMP API has no `credential_disabled` extension event. | Keep `agent_end` cleanup; revisit when OMP exposes a real event. |
| O8 | P3 | Deferred | `src/ai/final-message.ts:89-123`, `src/ai/structured-output.ts:214-219` | Stop reasons are not preserved in structured agent runs. | Defer until metrics show truncation/refusal failures. |
| O9 | P3 | Deferred | `src/harness/tools.ts`, `src/ultraplan/authoring/authoring-tools.ts` | Custom artifact tools do not surface ACP locations. | Add result-side links/locations when OMP supports them. |
| O10 | P3 | No action | see table above | Transparent runtime benefits and native-command fixes. | No code change. |
