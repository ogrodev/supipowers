# OMP Changelog Audit

**OMP version analyzed:** `@oh-my-pi/pi-coding-agent@13.10.1`
**Audit date:** 2026-04-14
**supipowers version at time of audit:** 1.5.0

---

## Breaking Changes — Impact on supipowers: None

### 1. `searchDb` removed from extension contexts

Removed from `ToolSession`, `CustomToolContext`, `ExtensionContext`, and `CreateAgentSessionOptions`.

**Impact:** None. No `searchDb` usage exists anywhere in `src/`.

---

### 2. Task tool `schema` field now requires JSON-encoded JTD string

Previously accepted a schema object; now requires a JSON-encoded JTD schema text string.

**Impact:** None. Our `createAgentSession` calls only pass `cwd`, `model`, `thinkingLevel`, and `hasUI`. The TypeBox schemas in `src/review/output.ts` are used for prompt/retry rendering logic and are never forwarded as the `schema:` option into the Pi API.

---

### 3. Edit tool schema restructured (`edits[]` array, new chunk selector format)

Patch, replace, hashline, and chunk modes moved from top-level request fields to `edits` array entries. Chunk selectors are now encoded as `path: "file:selector"`.

**Impact:** None. We never construct edit payloads programmatically. Our auto-fix path (`src/review/fixer.ts`) only prompts a headless agent session; the AI calls edit tools natively within Pi. Our review agent prompt files (`agent-review-wrapper.md`, `output-instructions.md`, `fix-findings.md`) contain no explicit edit schema instructions.

---

### 4. `/rename` added as a built-in Pi slash command

Pi now intercepts `/rename <title>` to name the active session.

**Impact:** None. `src/bootstrap.ts` registers no command named `rename`. No collision.

---

### 5. OpenAI websockets transport default changed to off

`providers.openaiWebsockets` now defaults to disabled unless explicitly enabled.

**Impact:** None. We configure no provider transport settings in supipowers.

---

### 6. Vim tool API changes and removal from built-in tool list

Standalone vim tool removed; vim-style editing now invoked through edit in vim mode. API now requires `open: "path"` or `kbd: [...]` per call.

**Impact:** None. We never reference the vim tool.

---

## Opportunities

### 1. First-class session naming via `setSessionName` [MEDIUM-HIGH priority, medium effort]

Pi now has `/rename <title>` and a `session_name` status bar segment that shows the session name with a stable hash-derived accent color. This is directly useful for `/supi:plan`, `/supi:review`, and `/supi:qa`.

**Do not** emit `/rename` as a steer message — that goes through input event parsing, not the message delivery path.

**Correct approach:**
- Add optional `setSessionName?(name: string): void` to `Platform` in `src/platform/types.ts`
- Forward it in `src/platform/omp.ts` to the underlying OMP session manager's `setSessionName` (already present in the OMP source at the installed version)
- Call it at the start of each command: e.g. `platform.setSessionName?.("Plan: <feature>")`, `platform.setSessionName?.("Review: PR #123")`

For headless review sub-agents, call `session.setSessionName?.(agent.name)` after `createAgentSession(...)` in the multi-agent runner.

---

### 2. Multi-file auto-fix batching + widen `ReviewFixRecord.file` [MEDIUM priority, low–medium effort]

Pi now groups `edits[]` entries by file path automatically, so one `edit` call can touch N files in a single round-trip.

**Prompt change** (`src/review/prompts/fix-findings.md`): update to explicitly prefer one multi-file edit call when findings span multiple files, rather than the current "group related edits by file" guidance which is vague about call count.

**Type change** (`src/types.ts`): `ReviewFixRecord.file: string | null` should become `files: string[] | null`. A single auto-fix pass can now legitimately touch more than one file, and the single-field representation under-reports what happened in session artifacts.

---

### 3. Streaming review session TUI visibility [AUTOMATIC, no action required]

Pi fixed session event delivery so streaming `message_update` and tool-call previews reach the TUI immediately instead of waiting for extension handlers to finish. Our review progress widget gets better live feedback for free during headless agent sessions.

---

### 4. Planning system-prompt strip simplification [LOW priority, small effort]

Eager todo enforcement now applies only on the first user message of a conversation — subsequent correction/redirect turns are exempt.

`src/planning/system-prompt.ts` currently strips the entire `Rules` section from the base system prompt before injecting planning-mode instructions. That was a broad measure to suppress unwanted todo behavior. Worth reviewing whether the strip can be narrowed now that mid-session turns are todo-exempt by default.

Note: the first-message exemption does not change our kickoff flows — `/supi:plan` and `/supi:qa` both send their kickoff as the first `sendUserMessage`, so first-message todo behavior still applies there (and is intentional for plan execution). This is a prompt quality cleanup, not a required fix.

---

### 5. Safer headless session disposal [AUTOMATIC, no action required]

`AgentSession.dispose()` now only shuts down Python kernels owned by that session. Our review pipeline creates many short-lived headless sessions across initial review, validation, and fix passes and always disposes them in `finally` blocks (`src/quality/ai-session.ts`). This Pi fix reduces cross-session kernel teardown risk automatically.

---

## Summary

| Item | Type | Priority | Action |
|---|---|---|---|
| `searchDb` removal | Non-issue | — | None |
| Task schema → JTD string | Non-issue | — | None |
| Edit tool schema restructure | Non-issue | — | None |
| `/rename` command conflict | Non-issue | — | None |
| OpenAI websockets default | Non-issue | — | None |
| Vim tool API changes | Non-issue | — | None |
| Session naming via `setSessionName` | Opportunity | Medium-high | Add to Platform adapter; call in plan/review/qa |
| Multi-file fix batching + `ReviewFixRecord.files[]` | Opportunity | Medium | Update fixer prompt + widen type in `src/types.ts` |
| Streaming delivery improvement | Automatic | — | None |
| Planning prompt strip simplification | Opportunity | Low | Revisit `stripBetween` scope in `system-prompt.ts` |
| Safer session disposal | Automatic | — | None |
