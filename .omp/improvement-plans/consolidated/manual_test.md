# Command Testing Guide — Phases 1-8

Commands are grouped by how much changed. For each: what runs through new code, how to invoke, what success looks like, and what failure cases to deliberately trigger.

Side-effect paths to watch across most commands:
- `.omp/supipowers/reliability/events.jsonl` — one JSONL line appended per AI attempt
- `.omp/supipowers/plans/` — PlanSpec-validated files only
- `.omp/supipowers/fix-pr-sessions/<id>/ledger.json` — now includes `assessment` field

---

## 1. `/supi:plan`

**What changed:** Phase 3 schema-first validation in approval-flow; Phase 4 runtime tool-guard; Phase 8 reliability records.

**Invoke:** `/supi:plan` with any feature request.

**Expected happy path:**
- Agent writes a plan under `.omp/supipowers/plans/YYYY-MM-DD-<name>.md`
- Approval UI appears with three options: `Approve and execute`, `Refine plan`, `Stay in plan mode`
- `reliability/events.jsonl` gets a line: `{ "command": "plan", "operation": "plan-spec", "outcome": "ok", ... }`

**Deliberate failure cases:**
1. **Invalid PlanSpec** — if the agent writes a plan without frontmatter or with a task complexity like `"epic"` instead of `small|medium|large`, the approval UI should NOT appear. Instead: a steer message is sent back to the agent listing the validation errors. `reliability/events.jsonl` records `outcome: "blocked"`.
2. **`ask` vs `planning_ask`** — if the agent tries to call the generic `ask` tool during a planning session, the tool_call hook returns `{ block: true, reason: "...use the \`planning_ask\` tool..." }`. Observable in the agent's tool_result.

---

## 2. `/supi:review`

**What changed:** Phase 1 migrated every review runner/validator/fixer through the shared `runWithOutputValidation`; Phase 8 adds reliability records on each.

**Invoke:** `/supi:review` (quick or deep), against a branch with uncommitted changes or a PR scope.

**Expected happy path:**
- Same user-visible flow as before (scope selection, agents run, findings render, validator runs, optional fix + rerun)
- `reliability/events.jsonl` gets multiple lines per review run: one per agent runner invocation (`operation: "runner"`), one per validator call (`operation: "validator"`), one per fixer call when fix-now chosen
- The schema text in retry prompts is now auto-generated from `ReviewOutputSchema` — invisible to the user but means adding a field to the schema updates every prompt automatically

**Deliberate failure cases:**
1. **Model emits malformed JSON** — retry prompt appears (model sees its invalid output + schema + error). If 3 retries fail, review reports blocked status truthfully (not empty-findings).
2. **`fix-now` rerun loop** — after applying fixes, review should automatically invoke the runner a second time (verified by `eval:review-rerun-loop`).

---

## 3. `/supi:commit`

**What changed:** Phase 5 — migrated to `runWithOutputValidation` with TypeBox `CommitPlanSchema`; added staged-file coverage check; manual fallback ONLY after structured path is exhausted.

**Invoke:** `/supi:commit` with any set of staged files.

**Expected happy path:**
- Agent generates a validated commit plan covering every staged file exactly once
- Each commit's scope is clearly structured
- `reliability/events.jsonl` gets `{ "command": "commit", "operation": "commit-plan", "outcome": "ok" }`

**Deliberate failure cases:**
1. **Coverage violation** — if the agent produces a plan that misses a staged file or lists it twice, `validateCommitPlanCoverage` catches it → blocked status → manual fallback with a truthful reason. `reliability/events.jsonl` shows two records: one `outcome: "blocked"` then one `outcome: "fallback"`.
2. **Malformed JSON** — retry with schema feedback up to 3 times. If exhausted, manual fallback triggers (`outcome: "retry-exhausted"` then `outcome: "fallback"`).

---

## 4. `/supi:generate` (doc drift)

**What changed:** Phase 5 — doc-drift findings now parsed via `DocDriftOutputSchema`; heuristic "invented" drift findings removed; explicit blocked state on parse failure.

**Invoke:** `/supi:generate` in a repo with at least one sub-agent target.

**Expected happy path:**
- Typed findings render; `status` is either `ok` or `drifted`
- `reliability/events.jsonl` records per sub-agent: `{ "command": "docs", "operation": "drift-analyze", "outcome": "ok" }`

**Deliberate failure cases:**
1. **Malformed sub-agent response** — retry with schema feedback. On exhaustion, the sub-agent's output is added to `result.errors[]` and reported via `notifyError` rather than silently producing fake findings.
2. **Unknown severity value** — anything other than `info|warning|error` triggers schema mismatch → retry → blocked if retries exhaust.

---

## 5. `/supi:checks` (quality gates)

**What changed:** Phase 5 — the AI review gate, quality setup detection, and LSP diagnostics helper all use validated contracts through `runWithOutputValidation`. Phase 8 — reliability records on each.

**Invoke:** `/supi:checks` or whichever command triggers the gate suite (typically via the regular quality pipeline).

**Expected happy path for the AI review gate:**
- Gate produces `AiReviewOutput` artifact (findings + summary + status)
- `reliability/events.jsonl` records `{ "command": "quality-ai-review", "outcome": "ok" }`

**Expected happy path for quality setup (`ai-setup.ts`):**
- Typed `QualityGatesConfig` artifact returned; no silent empty-result fallback
- `reliability/events.jsonl` records `{ "command": "quality-setup", "outcome": "ok" }`

**Expected happy path for LSP diagnostics helper:**
- Typed `LspDiagnosticsResults` artifact returned
- Throws `LSP diagnostics integration failed: <error>` on exhausted retries — no silent empty-diagnostics fallback

**Deliberate failure cases:**
1. **Quality setup retry exhaustion** — throws with the real schema/parse error (preserves the throw contract for callers).
2. **LSP bridge schema mismatch** — throws with the field-level error path.

---

## 6. `/supi:fix-pr`

**What changed:** Phase 7 — typed `FixPrAssessmentBatch` artifact before edits begin; work batches derived from the artifact via connected-components on affectedFiles; ledger persists the artifact. Phase 8 — reliability records.

**Invoke:** `/supi:fix-pr <PR-number>` (or on the current branch's PR).

**Expected happy path:**
- After target selection and comment clustering, a validated assessment artifact is generated: `{ assessments: [...], summary? }`
- Each assessment has: `commentId`, `verdict` (`apply | reject | investigate`), `rationale`, `affectedFiles`, `rippleEffects`, `verificationPlan`
- Only `verdict: "apply"` assessments produce work batches. Batches group by shared-file (union-find over the affectedFiles graph), sorted by lowest `commentId`, named `batch-<minCommentId>`
- `ledger.json` under the session dir now contains an `assessment` field
- `reliability/events.jsonl` records `{ "command": "fix-pr", "operation": "assessment", "outcome": "ok" }`

**Deliberate failure cases:**
1. **Model produces invalid verdict** — retry with schema feedback; block on exhaustion
2. **Empty cluster** — assessment short-circuits with `{ assessments: [] }` without calling the agent (no reliability record is emitted in this no-op path)
3. **Known gap:** unresolved-selected-comments completion blocker is NOT yet enforced. Test by marking the command "complete" with open selected-target comments — current behavior does NOT block (this is the intentional `FIX-VIA` regression gate from `eval:fix-pr-blocks-complete-with-unresolved-selected-comments`)

---

## 7. `/supi:release`

**What changed:** Phase 7 — release-note polish and doc-fix subflows use typed contracts; release halts truthfully on contract failure. Phase 8 — reliability records.

**Invoke:** `/supi:release` through its normal flow.

**Expected happy path — release-note polish:**
- Agent returns `{ title, body, highlights, status: "ok" | "empty" }`
- `renderPolishedChangelog()` produces the final changelog markdown
- `reliability/events.jsonl` records `{ "command": "release", "operation": "note-polish", "outcome": "ok" }`

**Expected happy path — doc-fix subflow:**
- Agent returns `{ edits: [{ file, instructions }], summary, status: "ok" | "blocked" }`
- Release proceeds only if contract `ok` AND `output.status === "ok"`
- `reliability/events.jsonl` records `{ "command": "release", "operation": "doc-fix", "outcome": "ok" }`

**Deliberate failure cases:**
1. **Polish blocked** — previously degraded silently to raw changelog; now halts release with `notifyError` and the truthful reason
2. **Doc-fix status blocked** — the agent itself returned `status: "blocked"` in a valid artifact → release halts with the agent's summary as the reason
3. **Contract validation failure** — retries then blocks; release stops before any publish step

---

## 8. `/supi:qa`

**What changed in my work:** nothing in the command handler itself. Phase 7-06 only added **evals that assert the current structural ordering** holds (session creation before prompt building, early-return on missing config). The deeper QA completion-blocker work is deferred.

**Invoke:** `/supi:qa` normally.

**Expected behavior:** identical to before this roadmap. The evals document what to preserve when you make future changes.

---

## 9. `/supi:status`

**What changed:** Phase 8 — adds a Reliability section showing per-command aggregates.

**Invoke:** `/supi:status` after running any AI-heavy command at least once.

**Expected output:**
- Before the existing Close section, a new block:
  ```
  Reliability (last N record(s))
  plan      ok <N> blocked <N> retry-exhausted <N> fallback <N> agent-error <N>   avg-attempts <X.XX>   last <YYYY-MM-DD>
  commit    ok <N> ...
  ```
- Empty-state when no records exist: single line `Reliability: no records yet (metrics appear after AI-heavy commands run).`

**Deliberate test:** delete `.omp/supipowers/reliability/events.jsonl`, run `/supi:status`, confirm empty-state line renders without crashing.

---

## 10. `/supi:doctor`

**What changed:** Phase 8 — appends the same reliability section after the existing diagnostics report.

**Invoke:** `/supi:doctor`.

**Expected output:** existing diagnostics summary followed by the reliability rows (same format as `/supi:status`).

---

## Cross-command runtime behaviors worth spot-checking

These aren't commands — they're hooks that fire across every command.

**Context-mode tool routing (unchanged behavior, but tool contracts tightened in Phase 2):**
- Calling `grep` or `bash grep/find` when context-mode is active returns a block reason pointing at `ctx_search` / `ctx_batch_execute`
- Calling `curl`/`wget` returns a block reason pointing at `ctx_fetch_and_index`
- Every tool (`ctx_index`, `ctx_search`, `ctx_fetch_and_index`, `ctx_stats`, `ctx_purge`) now carries `promptGuidelines` describing when to use / when not to

**Planning-mode `ask` guard (new in Phase 4):**
- During an active planning session, any call to the generic `ask` tool is blocked with a redirect to `planning_ask`
- Verify by: `/supi:plan` → have the agent attempt to call `ask` → observe the block reason in the tool_result

---

## Quick smoke-test script

If you want the shortest path to exercise every new surface in one sitting:

1. `rm -rf .omp/supipowers/reliability/` to get a clean metrics slate
2. `/supi:plan add a hello world function` — exercise PlanSpec validation + planning_ask guard + reliability record
3. Approve the plan and let it execute, then `/supi:commit` — exercise commit-contract + reliability record
4. `/supi:review` on those changes — exercise review shared-foundation + reliability records
5. `/supi:status` — confirm reliability scorecard renders with entries from steps 2-4
6. `cat .omp/supipowers/reliability/events.jsonl` — confirm one line per AI attempt

Any command whose `reliability/events.jsonl` line is missing or has `outcome: "blocked"` unexpectedly is a bug worth investigating.
