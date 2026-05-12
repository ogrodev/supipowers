# OMP Changelog Audit — 14.9.3 → 14.9.8

| Field | Value |
|---|---|
| OMP version range claimed | 14.9.3 → 14.9.8 |
| OMP versions with changelog entries in this range | 14.9.5, 14.9.7, 14.9.8 |
| supipowers version | 2.0.2 |
| Audit date | 2026-05-12 |
| Prior audit baseline | 14.9.3 (`.omp/omp-audit-config.json`) |

## Executive summary

**Zero hard runtime breakages in supipowers source.** Each of the three breaking-change clusters in this window — the `eval` cell header rewrite (14.9.8), the Jupyter kernel-gateway removal (14.9.7), and the `jobs://` URL removal (14.9.5) — touches APIs that supipowers never calls directly. The agents we spawn through `createAgentSession` will see the new eval prompt format and lose the `jobs://` URL, but they reach those tools through OMP's runtime, not through supipowers code.

Evidence (each command grep'd across `src/ tests/ skills/ docs/ scripts/ bin/`, excluding `node_modules/` and `omp_source/`):

- `grep -rn 'jobs://'` → no matches
- `grep -rn 'jupyter\|sharedGateway\|PI_PYTHON_GATEWAY\|omp jupyter'` → no matches
- `grep -rn '\*\*\* Begin\|\*\*\* End\|\*\*\* Cell\|\*\*\* Title\|\*\*\* Timeout\|\*\*\* Reset'` → no matches in our code (`*** Begin <LANG>` appears only inside `omp_source/` vendor tree and OMP's own CHANGELOG)
- `grep -rn 'HistoryStorage'` → no matches (our event store is independent, `src/context-mode/event-store.ts`)
- `grep -rn 'search_issues\|search_prs\|search_commits\|search_repos'` → no matches in production code (one literal `gh pr create` example string in `src/git/branch-finish.ts:79` is unrelated)

One **stale comment** is the only documentation drift produced by this window:

- 14.9.5 changes `ask.timeout` default from `30` (seconds) to `0` (wait indefinitely). `src/planning/planning-ask-tool.ts:8` still documents the OMP default as `30s`. The `planning_ask` tool itself remains valuable (it both bypasses any user-set `ask.timeout > 0` *and* hooks `recordUiDesignReviewApproval`, and the `registerPlanningAskToolGuard` runtime guard at line 108 still blocks `ask` during planning / ui-design sessions). The doc string needs a one-line correction; the tool stays.

Three **transparent reliability wins** land automatically for every `createAgentSession` call supipowers makes (35 callsites across the subsystems listed in the brief):

1. **14.9.5 cross-session resolution for `agent://` / `artifact://` / `memory://`.** Spawned subagents can now read each other's outputs by ID across active sessions. `src/ultraplan/runtime/reducer.ts:213` constructs `artifact://${phase}-${attemptId}` refs and stores them in scenario proofs; downstream ultraplan agents reading those proofs (`tests/ultraplan/runtime/proof.test.ts:56,80,110,153,210`) will now resolve them across session boundaries instead of only within the originating session.
2. **14.9.5 per-agent job scoping for the `job` tool and `AsyncJobManager`.** Subagent disposal no longer cancels parent jobs, and ultraplan supervisor sessions stop fighting child cleanup. This shields `src/commands/ultraplan.ts`'s batch flows (which spawn worktree agents) from the prior global-cancel cascade.
3. **14.9.8 conflict-aware `read` + `conflict://` writes.** Subagents spawned by ultraplan merge / fix-pr flows (`src/ultraplan/batch/merge.ts`, `src/fix-pr/assessment.ts`) automatically gain merge-conflict introspection (`:conflicts` selector, `conflict://<N>` URL, bulk `conflict://*` write). No supipowers code needs to change to benefit.

Verified non-impacting breaking changes:

- **14.9.8** `eval` tool input format moved from `*** Begin <LANG>` / `*** End <LANG>` to single-line `*** Cell <lang>:"<title>"` headers. supipowers never constructs eval inputs (`grep -rn '\*\*\* Begin'` → only `omp_source/` and OMP's own CHANGELOG). Subagents we spawn will see the new prompt format from OMP directly.
- **14.9.7** removed `jupyter_kernel_gateway` / `ipykernel`, the `python.sharedGateway` setting, the `omp jupyter` CLI, and `PI_PYTHON_GATEWAY_URL` / `PI_PYTHON_GATEWAY_TOKEN`. supipowers does not reference any of these (`grep -rin 'jupyter\|sharedGateway\|PI_PYTHON_GATEWAY'` → no matches).
- **14.9.7** disabled `timeoutMs` enforcement for worker-based JS eval. supipowers uses `timeoutMs` only on its own `createAgentSession`-based pipelines (`src/review/multi-agent-runner.ts`, `src/quality/ai-session.ts` shape), not on the `eval` tool. Confirmed — our `timeoutMs` callers pass into `runStructuredAgentSession`, not `executeJs`.
- **14.9.5** removed the `jobs://` internal URL protocol. supipowers does not use `jobs://` anywhere (`grep -rn 'jobs://' src/ tests/ skills/ docs/ scripts/ bin/` → no matches).

## Breaking Changes

### B1 — 14.9.8: `eval` tool input format rewrite (`*** Begin <LANG>` → `*** Cell <lang>:"<title>"`)

**Changelog (14.9.8 Breaking Changes).**

> Changed the `eval` tool input format to a single-line `*** Cell <lang>:"<title>" [t:<duration>] [rst]` header per cell, replacing the `*** Begin <LANG>` / `*** End <LANG>` envelope and the standalone `*** Title:` / `*** Timeout:` / `*** Reset` directives.

**Status.** No supipowers code break. supipowers never synthesizes eval inputs; the only `Cell` symbols in our source are markdown table helpers (`src/harness/stages/design.ts:35,192` `mdCell`, `src/harness/anti_slop/architecture-parser.ts:44,123,124,125` `parseListCell`, `src/harness/pr-comment/render.ts:210,212` `deltaCell`) and unrelated harness validate stub (`src/harness/stages/validate.ts:7` mentions `eval (placeholder)` in a comment).

**Evidence.**
```
$ grep -rn '\*\*\* Begin\|\*\*\* End\|\*\*\* Cell\|\*\*\* Title\|\*\*\* Timeout\|\*\*\* Reset' \
    src/ tests/ skills/ docs/ scripts/ bin/ .omp/
(no matches)
```

All references in the workspace point at `omp_source/packages/coding-agent/...` (vendor) and `node_modules/@oh-my-pi/pi-coding-agent/CHANGELOG.md`. Subagents spawned through `createAgentSession` consume the OMP-rendered `eval` prompt at runtime; their behavior is OMP's concern, not ours.

**Recommendation.** None.

---

### B2 — 14.9.7: Jupyter kernel gateway replaced with NDJSON subprocess; `omp jupyter` CLI, gateway env vars, and `python.sharedGateway` setting removed

**Changelog (14.9.7 Breaking Changes).**

> Replaced the Jupyter kernel gateway + WebSocket protocol behind the Python `eval` backend with a subprocess-backed runner that speaks NDJSON over stdin/stdout; removed the `jupyter_kernel_gateway` / `ipykernel` pip dependencies, the `python.sharedGateway` setting, the `omp jupyter` CLI command, and the `PI_PYTHON_GATEWAY_URL` / `PI_PYTHON_GATEWAY_TOKEN` environment variables.

**Status.** No supipowers code break. We do not orchestrate Jupyter or shell out to `omp jupyter` from any command, hook, or installer.

**Evidence.**
```
$ grep -rin 'jupyter\|sharedGateway\|PI_PYTHON_GATEWAY\|omp jupyter\|jupyter_kernel\|gatewayUrl' \
    src/ tests/ skills/ docs/ scripts/ bin/ package.json README.md CHANGELOG.md
(no matches)
```

`platform.exec` is invoked in 24 files; none of them shell out to `omp jupyter`. The Python tool is consumed by subagents via OMP's runtime, which transparently switches to the subprocess runner.

**Recommendation.** None. If we ever document Python eval support in our user-facing docs, drop any reference to a Jupyter kernel gateway — that is no longer accurate.

---

### B3 — 14.9.7: `timeoutMs` no longer enforced for worker-based JS eval runs

**Changelog (14.9.7 Breaking Changes).**

> Changed the `timeoutMs` execution option to no longer be enforced during worker-based JS runs, so callers must rely on external cancellation signals for time limits.

**Status.** No supipowers code break. The `timeoutMs` options we set go to `createAgentSession`-based pipelines (`src/review/multi-agent-runner.ts:runWithOutputValidation`, the `runStructuredAgentSession` helper used by quality gates), **not** to the `eval` tool. The agent-session timeout is a parameter on `Platform.createAgentSession()` — that is unaffected.

**Evidence (relevant call sites).**

- `src/review/multi-agent-runner.ts` — `timeoutMs: input.timeoutMs ?? 120_000` flows into `runWithOutputValidation` → `runStructuredAgentSession` (agent-session, not eval tool).
- `src/quality/runner.ts` — no `timeoutMs` on `executeJs` calls; `platform.exec` calls use a separate `timeout` field on `ExecOptions`.

No supipowers code passes `timeoutMs` into a JS `eval` invocation.

**Recommendation.** None.

---

### B4 — 14.9.5: `jobs://` internal URL protocol removed

**Changelog (14.9.5 Breaking Changes).**

> Removed the `jobs://` internal URL protocol; inspect background jobs via the `job` tool's `list: true` operation instead.

**Status.** No supipowers code break. supipowers does not reference `jobs://` anywhere — neither in source, tests, skills, docs, scripts, nor bin. Subagents we spawn lose the `jobs://` URL in their system prompts (OMP renders the URL list), and OMP has already updated its built-in tool prompts to point at the `job` tool's `list: true` op (`node_modules/@oh-my-pi/pi-coding-agent/src/prompts/tools/bash.md:15-17`, `task.md:4-5`).

**Evidence.**
```
$ grep -rn 'jobs://' src/ tests/ skills/ docs/ scripts/ bin/
(no matches)
```

The 4.2 KB of `jobs://` hits in the workspace all point at `node_modules/` and `omp_source/` — vendor trees that ship with OMP itself.

**Recommendation.** None.

---

## Opportunities

### O1 — 14.9.5: `ask.timeout` default changed from `30` to `0`; refresh stale comment on `planning_ask`

**Changelog (14.9.5 Changed).**

> Changed the `ask.timeout` default from `30` (seconds) to `0` (wait indefinitely). Auto-selecting the recommended option after a fixed delay was surprising users mid-deliberation; the timer is now strictly opt-in. The legacy auto-select behavior is preserved when `ask.timeout` is set to a non-zero value, and the `ask` tool's prompt has been updated so the model expects unlimited reply time by default.

**Impact.** The doc comment in `src/planning/planning-ask-tool.ts:5-13` describes the original rationale for the `planning_ask` tool as bypassing OMP's "`ask.timeout` setting (default 30s)". That default is now `0`, so the comment overstates the urgency. **The tool itself stays.** Three reasons to keep it:

1. Users with explicit `ask.timeout > 0` still benefit from the no-timeout planning question path.
2. `planning_ask.execute()` calls `recordUiDesignReviewApproval` (line 71) to thread the user's choice into the ui-design session ledger — that side effect is not available on the generic `ask` tool.
3. `registerPlanningAskToolGuard` (line 108-120) registers a `tool_call` hook that blocks the generic `ask` tool during planning / ui-design sessions and returns a redirect message; deleting `planning_ask` would also lose this auditable redirect path.

The existing eval `tests/evals/plan-uses-planning-ask.test.ts` reinforces this — it asserts that planning mode names `planning_ask` in both the tool description and the system prompt. Both reasons survive the OMP default change.

**Priority:** P3
**Effort:** XS (single comment edit)
**Recommendation.** Replace the line at `src/planning/planning-ask-tool.ts:7-10` to drop the "default 30s" claim. Suggested wording:

```ts
/**
 * Register a `planning_ask` tool — identical to the built-in `ask` tool
 * but with **no timeout**, regardless of the user's `ask.timeout` setting.
 * Also records the chosen option into the ui-design session ledger via
 * `recordUiDesignReviewApproval`.
 *
 * The tool is always registered (lightweight) but the planning system
 * prompt directs the model to use it only during planning sessions.
 */
```

This is the smallest correct fix: removes the inaccurate `30s` claim, keeps every architectural reason for the tool intact, and preserves the eval contract.

---

### O2 — 14.9.5: cross-session resolution for `agent://`, `artifact://`, `memory://` URLs

**Changelog (14.9.5 Changed).**

> Changed `agent://` and `artifact://` URL resolution to search artifact outputs across all active sessions instead of only the current session, allowing parent and subagent sessions to read each other's generated outputs by ID.
> Changed `memory://` URL resolution to walk all active sessions' memory roots and return the first matching file…

**Impact.** supipowers writes `artifact://<id>` proof refs into ultraplan scenario records:

- `src/ultraplan/runtime/reducer.ts:213` — `artifactRef: proof.artifactRef ?? \`artifact://${proof.phase}-${active.attemptId}\``
- `tests/ultraplan/runtime/proof.test.ts:56,80,110,153,210` and `tests/ultraplan/storage.test.ts:274,287` — every proof carries an `artifact://...` ref.

Before 14.9.5, a subagent that the orchestrator spawned could not resolve `artifact://...` URLs created by another sibling subagent (each session was isolated). With 14.9.5, the harness now walks all active sessions to find the artifact. Ultraplan executors that consume a peer agent's proof artifact (e.g. the tester role reading the executor's red proof in `src/ultraplan/runtime/repair.test.ts:307`, `tests/ultraplan/runtime/integration.test.ts:250,333`) get this for free.

**Priority:** P3 (transparent benefit, no code change required)
**Effort:** None (runtime behavior change in OMP)
**Recommendation.** Document the new cross-session resolution in `docs/supipowers/ultraplan-authoring.md` so the contract is explicit: scenario proofs stored as `artifact://<id>` are now legible across the entire ultraplan session graph. No code edits.

---

### O3 — 14.9.5: per-agent job scoping shields ultraplan supervisor sessions from cascade cancellation

**Changelog (14.9.5 Changed/Fixed).**

> Changed subagent session switches and handoff paths to stop global async-job cancellation and cancel only jobs owned by that session.
> Fixed subagent disposal and session transitions that previously canceled all running async jobs, preventing inadvertent termination of a parent agent's background work.

**Impact.** `src/commands/ultraplan.ts` orchestrates supervisor + worktree agents and uses `platform.exec` for `git` calls inside `BATCH_GIT_TIMEOUT_MS`-bounded subprocesses. Prior to 14.9.5, a subagent finishing a phase could implicitly tear down the orchestrator's running `bash`/`task` jobs through the global `AsyncJobManager`. The 14.9.5 owner-scoping eliminates that hazard. No supipowers code change needed.

**Priority:** P3
**Effort:** None (runtime behavior change)
**Recommendation.** None — confirmed safe to delete any defensive "re-run job" retry shim that exists today (none was found, so no action needed). Note this win in the next release CHANGELOG.

---

### O4 — 14.9.8: conflict-aware `read` and `conflict://` write tooling for ultraplan merge / fix-pr flows

**Changelog (14.9.8 Added).**

> Added `:conflicts` read selector (`read <path>:conflicts`) to return a one-line index of all unresolved merge conflicts with stable `#N` IDs for quick inspection.
> Added bulk conflict resolution with `write({ path: "conflict://*", content })` to resolve all currently registered conflicts across files in one call…
> Added detection of unresolved git merge conflicts in `read` output: each marker block is registered with a session-stable id…

**Impact.** `src/ultraplan/batch/merge.ts` returns `kind: "blocked"` with code `"merge-blocked"` (line 37) when `mergeBranch()` fails. Today the user is left to resolve the conflict by hand or hand it to a fresh agent without structured context. Subagents spawned by `/supi:ultraplan` and `/supi:fix-pr` now see merge-marker warnings on every `read`, can list all conflicts with `read <path>:conflicts`, and can resolve them with `write({ path: "conflict://<N>", content })` or bulk `write({ path: "conflict://*", content })`. This is a no-supipowers-code win for any subagent that already knows how to use those tools.

There is also an explicit lever supipowers could pull: when a merge ends with `merge-blocked`, the orchestrator could include a hint in the follow-on agent prompt that names the new tooling. This is small and worthwhile if we see ultraplan agents repeatedly stalling on conflicts.

**Priority:** P3
**Effort:** S (optional prompt augmentation in `src/ultraplan/batch/merge.ts` or downstream resolver)
**Recommendation.** Defer until we observe an ultraplan agent struggling on a merge-blocked outcome. The runtime gain (conflict footers on `read`) is already free.

---

## Verified non-impacting changes (recorded for the next audit's baseline)

| Version | Entry | Verification |
|---|---|---|
| 14.9.5 | `since` / `until` filters added to `search_issues` / `search_prs` / `search_commits` / `search_repos` | supipowers does not call these tools from code (`grep` → no production hits). |
| 14.9.5 | `dateField` support for the above | Same as above. |
| 14.9.5 | `search_code` rejects `since` / `until` with validation error | Not used in production code. |
| 14.9.5 | `ModelRegistry.hasConfiguredAuth(model)` added (#993) | supipowers does not call `ModelRegistry` directly. |
| 14.9.5 | Keyless-by-design providers treated as authenticated for subagents (#1008) | Bug-fix path; no API consumed by supipowers. |
| 14.9.5 | Streaming-guard pre-emption for auto-generated files | Bug-fix; supipowers does not register custom auto-generation guards. |
| 14.9.5 | Plugin manifest directory-entry resolution fix | supipowers' `pkg.omp.extensions` points at a built file, not a directory. |
| 14.9.5 | Windows SSH ControlMaster fix (#154) | supipowers does not invoke the SSH tool directly. |
| 14.9.5 | `/export` and `/tree` show developer-role messages (#753) | OMP UI; no supipowers code path. |
| 14.9.5 | Browser tab worker single-file binary fix (#1011) | supipowers does not spawn tab workers. |
| 14.9.5 | IRC pre-registration of subagents in `# IRC Peers` block | Multi-agent runner already coordinates via OMP IRC (`src/review/multi-agent-runner.ts` peer-coordination block); the fix makes batched siblings visible immediately — transparent win. |
| 14.9.5 | ESM circular-import TDZ fix in task/tools | Internal OMP fix. |
| 14.9.5 | Multi-entry edit `isError` propagation | OMP renderer fix; supipowers does not synthesize multi-entry edits. |
| 14.9.7 | Python `tool.<name>(args)` bridge in `executePython` | Transparent for subagents; supipowers does not embed Python eval directly. |
| 14.9.7 | Per-execution Python tool bridge / status forwarding | Same. |
| 14.9.7 | Browser-tab JS exposes `read`/`write`/`sort`/`uniq`/`counter`/`diff`/`tree`/`env`/`output`/`display`/`tool` helpers | We do not spawn tabs directly. |
| 14.9.7 | Browser-tab JS static ESM `import` support | Same. |
| 14.9.7 | `HistoryStorage.search` substring fallback + tokenization fix | We do not use OMP's `HistoryStorage`; our event store is independent (`src/context-mode/event-store.ts`). |
| 14.9.7 | Live single-line sync progress display in `stats` | OMP UI. |
| 14.9.7 | Inline JS evaluation fallback when worker creation fails | Transparent for subagents. |
| 14.9.7 | `setup python` simplified to verify Python 3 only | Internal OMP CLI. |
| 14.9.7 | `info` output drops Python Gateway block | Internal OMP CLI. |
| 14.9.7 | `executeJs` exposes the worker's real `process` object | Subagents only. |
| 14.9.7 | JS evaluation per-session worker runner | Subagents only. |
| 14.9.7 | Python subprocess + `SIGINT` cancellation | Subagents only. |
| 14.9.7 | Python magic compatibility (`%pip`, `%cd`, etc., `!shell`) without IPython | Subagents only. |
| 14.9.7 | `text/markdown` precedence over `text/plain` in Python output | Subagents only. |
| 14.9.7 | JS run cancellation also cancels in-flight tool calls and the worker session | Subagents only. |
| 14.9.7 | Top-level `const`/`let`/`class` persistence in JS eval | Subagents only. |
| 14.9.8 | Single-conflict `write` retry re-locates by marker content | Subagents only. |
| 14.9.8 | `read conflict://*` wildcard rejected with write-only error | Subagents only. |
| 14.9.8 | Conflict resolution verifies live file still has markers | Subagents only. |
| 14.9.8 | `@base` token error for two-way conflicts without a base | Subagents only. |
| 14.9.8 | `*** Cell` header rejects invalid `rst` with clear error | Subagents only. |
| 14.9.8 | Conflict count metadata badge in `read` UI | Internal renderer. |
| 14.9.8 | Conflict warning footers show `X of Y` with `:conflicts` hint | Internal renderer. |
| 14.9.8 | Conflict scanning inspects whole file with 10 MB cap | Internal scanner. |
| 14.9.8 | Conflict marker scanning rejects indented/malformed markers | Internal scanner. |
| 14.9.8 | `write` conflict resolution validates `conflict://` IDs | Internal validator. |
| 14.9.8 | HTML transcript renderer parses new `*** Cell` headers | Internal renderer; supipowers does not emit transcript HTML. |
| 14.9.8 | `eval` parser tolerates stray non-marker lines between cells | Subagents only. |
| 14.9.8 | `*** End` kept as optional terminator for GPT-trained models | Subagents only. |
| 14.9.8 | Explicit boolean `rst` values on `*** Cell` headers | Subagents only. |

## Summary table

| ID | Severity / Priority | File:Line | What it is |
|---|---|---|---|
| B1 | None | — | 14.9.8 `eval` cell header rewrite. supipowers never constructs eval inputs. |
| B2 | None | — | 14.9.7 Jupyter gateway removal. supipowers has no Jupyter or gateway code. |
| B3 | None | — | 14.9.7 `timeoutMs` no longer enforced for JS eval. Our `timeoutMs` is on `createAgentSession`, not `eval`. |
| B4 | None | — | 14.9.5 `jobs://` removal. supipowers has no `jobs://` references. |
| O1 | P3, XS | `src/planning/planning-ask-tool.ts:5-13` | Refresh stale "default 30s" comment after 14.9.5 changed `ask.timeout` default to `0`. Tool itself stays — still needed for `recordUiDesignReviewApproval` and the planning/ui-design `ask` guard. |
| O2 | P3, none | — | 14.9.5 cross-session `agent://` / `artifact://` / `memory://` resolution — transparent win for ultraplan scenario proofs (`src/ultraplan/runtime/reducer.ts:213`). |
| O3 | P3, none | — | 14.9.5 per-agent job ownership — transparent shield for ultraplan supervisor/worktree orchestration. |
| O4 | P3, S | `src/ultraplan/batch/merge.ts` | 14.9.8 conflict-aware `read` + `conflict://` writes — transparent for spawned subagents; optional prompt-level hint when `merge-blocked` occurs. |
