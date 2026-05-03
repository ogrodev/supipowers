# OMP Changelog Audit — 14.5.13 → 14.6.3

| Field | Value |
|---|---|
| OMP versions analyzed | 14.5.13, 14.5.14, 14.6.0, 14.6.1, 14.6.2, 14.6.3 |
| supipowers version | 1.5.3 |
| Audit date | 2026-05-03 |
| Prior audit baseline | 14.5.12 (`.omp/omp-audit-config.json`) |

## Executive summary

**Three breaking impacts**, all rooted in the OMP 14.6.0 rename of `search` / `find` / `ast_grep` / `ast_edit` from a single comma-or-whitespace-delimited `path: string` (and `pattern: string` for `find`) to `paths: string[]`. Two of them silently degrade dedup/cache hashing and one hard-blocks legitimate agent activity inside `/supi:ui-design`.

| ID | Severity | File:Line | What breaks |
|---|---|---|---|
| **B1** | **Critical** | `src/ui-design/session.ts:768-793` | UI-design tool guard reads `input.path` for `ast_edit`; field is now `input.paths: string[]`. Every `ast_edit` call inside an active ui-design session is rejected with "cannot verify ast_edit without a path". |
| **B2** | **High** | `src/context-mode/source-hash.ts:126-138` | `uniqueSourceHash` for `search` reads `input?.path`; for `find` reads `input?.pattern`. Both fields are gone in 14.6.0+. `find` silently collapses to a single hash bucket per project → distinct calls returning identical content get rewritten to `[…dedup: same as turn N]` placeholders. |
| **B3** | **Medium** | `skills/context-mode/SKILL.md:40` | Skill example `search(pattern: "TODO", path: "src/")` teaches agents the obsolete shape. Agents reading the skill emit invalid tool calls under 14.6.0+. |

Tests `tests/ui-design/session.test.ts:303-373` and `tests/context-mode/source-hash.test.ts:158-204` assert the obsolete shape and **must** be migrated in lockstep with the source fixes.

**No** confirmed impacts from python-tool removal (14.5.13), hindsight memory subsystem (14.6.3), `PI_HASHLINE_SEP` rename (14.6.3), or autoresearch overhaul (14.6.0). Verified by exhaustive grep across `src/`, `tests/`, `skills/`.

---

## Breaking Changes

### B1 — UI-design tool guard rejects every `ast_edit` call (Critical)

**Source.** `src/ui-design/session.ts:768-793` (function `getUiDesignWritePaths`):

```ts
case "ast_edit": {
  const raw = typeof input.path === "string" ? input.path : "";
  if (raw.length === 0) return [""];
  // OMP ast_edit accepts comma-separated path lists. Preserve whitespace inside literal paths.
  const segments = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return segments.length > 0 ? segments : [raw];
}
```

**OMP change.** 14.6.0:

> Changed `search`, `find`, `ast_grep`, and `ast_edit` to accept `paths: string[]` instead of comma- or whitespace-delimited path strings.

**Confirmation.** Active OMP tool catalog shows `ast_edit` with `paths` (array, required). The 14.5.12 schema snapshot at `omp_source/packages/coding-agent/src/tools/ast-edit.ts:46-49` still has `path: Type.String(...)`; that's the pre-rename version we already pinned at the prior audit.

**Impact.** When the agent runs `ast_edit` inside an active ui-design session, OMP delivers `event.input = { paths: [...], ops: [...] }`. `getUiDesignWritePaths` reads `input.path`, gets `undefined`, returns `[""]`, and the surrounding loop at `src/ui-design/session.ts:820-826` blocks the call with:

```
UI-design mode: cannot verify ast_edit without a path under `<sessionDir>`.
```

Every legitimate `ast_edit` is hard-blocked. The agent has no recourse other than abandoning ast_edit (degrading to text-only `edit`) or aborting the ui-design session.

**Test surface affected.** `tests/ui-design/session.test.ts` lines 308, 318, 328, 340, 354, 358, 369 — six tests pass `{ path: ... }` to the guard and assert the legacy comma-split semantics. They will pass under the obsolete code but lock supipowers into the old shape.

**Recommendation.**

1. Update `getUiDesignWritePaths` `ast_edit` branch to:
   - Read `input.paths` (array). Fall back to `input.path` (legacy string) for one release with a deprecation TODO so users on a stale OMP install don't hit a guard regression.
   - Remove the comma-split branch — `paths` is already an array.
2. Update the six tests to pass `paths: [...]` arrays. Keep one test for the legacy `path` fallback if you elect a transitional dual-read; otherwise delete the comma-split tests outright (clean cutover).

Sketch:

```ts
case "ast_edit": {
  const arr = Array.isArray(input.paths)
    ? input.paths.filter((p): p is string => typeof p === "string")
    : typeof input.path === "string" ? [input.path] : [];   // legacy 14.5.x fallback — drop next release
  return arr.length === 0 ? [""] : arr;
}
```

The `edit` and `notebook` branches already use the correct field names (`edits[].path` and `notebook_path`); they are untouched by 14.6.0.

---

### B2 — `uniqueSourceHash` collapses multiple find/search calls into a single dedup bucket (High)

**Source.** `src/context-mode/source-hash.ts:126-138`:

```ts
case "search": {
  const p = typeof input?.path === "string" ? input.path : "";
  if (!p) {
    const pattern = typeof input?.pattern === "string" ? input.pattern : "";
    return sha256Hex(`search:${pattern}:${projectSlug}`);
  }
  const absolute = canonicalizePath(p, cwd);
  return sha256Hex(`search:${absolute}:${projectSlug}`);
}
case "find": {
  const pattern = typeof input?.pattern === "string" ? input.pattern : "";
  return sha256Hex(`find:${pattern}:${projectSlug}`);
}
```

**OMP change.** 14.6.0 renamed `search`/`ast_grep`/`ast_edit` `path: string` → `paths: string[]`, and replaced `find`'s `pattern: string` (which previously bundled the glob and search root) with `paths: string[]`.

**Impact paths.**

- **`search`:** `input.path` is always undefined under 14.6.0+. Hash falls through to the pattern-only branch — still distinct per `pattern`, but loses path-scope distinction. Two searches for `TODO` in different directories now collide on a single hash.
- **`find`:** `input.pattern` is always undefined under 14.6.0+ (the field is gone — `find` no longer has a `pattern` argument; it takes `paths: string[]`). Every `find` call hashes to `find::<projectSlug>` (constant for the project). All `find` calls in a session share a single dedup record.

**Why this is more than cosmetic.** `sourceHash` feeds `maybeSubstitute` in `src/context-mode/dedup.ts:56-97`. That function compares the new content hash against the record stored under the same `sourceHash` key:

- Two distinct `find` calls returning **different** content → record is updated, second result gets a `[… supersedes turn N…]` banner. Annoying but not corrupting.
- Two distinct `find` calls returning **the same** content (e.g. both happen to return the same handful of files) → second result is **replaced** by `[…dedup: same as turn N (…); processor=passthrough]`. Agent sees a placeholder pointing at an unrelated earlier call. **Real regression:** the agent never sees the actual second-call output, just a stub referencing turn N.

The same hash also feeds `cacheStore.putText` (`src/context-mode/hooks.ts:582`, used at line 541) and the `unique_source_hash` column in `metrics-store` (`src/context-mode/metrics-recorder.ts:131-153`). Both of those are tag-only consumers — the cache key is content-based and the metric is for analytics — so the impact is contained to the dedup substitution path.

**Test surface affected.** `tests/context-mode/source-hash.test.ts:158-204` asserts the legacy `pattern`/`path` shapes (lines 161, 167, 178). They lock the old behavior in place.

**Recommendation.**

1. Update both branches to read `input.paths: string[]`:

   ```ts
   case "search": {
     const paths = Array.isArray(input?.paths)
       ? (input.paths as unknown[]).filter((p): p is string => typeof p === "string")
       : [];
     const pattern = typeof input?.pattern === "string" ? input.pattern : "";
     if (paths.length === 0) {
       return sha256Hex(`search:${pattern}:${projectSlug}`);
     }
     // Canonicalize and join so [a, b] and [b, a] hash differently — order matters
     // because OMP runs each path separately under root-level resolution (14.6.0).
     const absolute = paths.map((p) => canonicalizePath(p, cwd)).join("\u0001");
     return sha256Hex(`search:${absolute}:${pattern}:${projectSlug}`);
   }
   case "find": {
     const paths = Array.isArray(input?.paths)
       ? (input.paths as unknown[]).filter((p): p is string => typeof p === "string")
       : [];
     if (paths.length === 0) {
       // Should not happen under 14.6.0+ (paths is required), but be defensive.
       return sha256Hex(`find::${projectSlug}`);
     }
     const absolute = paths.map((p) => canonicalizePath(p, cwd)).join("\u0001");
     return sha256Hex(`find:${absolute}:${projectSlug}`);
   }
   ```

2. Rewrite the three tests at `tests/context-mode/source-hash.test.ts:158-204` to assert the new shape. Keep the "missing input keys returns null" test at line 195 — it uses `{ tool: "read", input: {} }` and is unrelated.

3. **Storage hygiene:** the existing v1→v2 migration in `src/context-mode/metrics-store.ts:261-284` (the `grep`→`search` rename precedent) is the template. Rows persisted under the old `find:<pattern>:<slug>` and `search:<path>:<slug>` hashes can never collide with the new `find:<paths>:<slug>` and `search:<paths>:<pattern>:<slug>` hashes (different prefixes, different inputs, same project salt), so a soft migration that nulls `unique_source_hash` on rows where `tool IN ('search','find')` AND `unique_source_hash` predates the bump is safest. Add a `user_version = 3` migration mirroring the v1→v2 block.

---

### B3 — Skill example teaches the obsolete `path:` shape (Medium)

**Source.** `skills/context-mode/SKILL.md:40`:

```
// WRONG — blocked, returns error
search(pattern: "TODO", path: "src/")

// CORRECT — runs in sandbox, only printed summary enters context
ctx_execute(language: "shell", code: "grep -rn TODO src/")
```

**OMP change.** Same as B1/B2.

**Impact.** The "WRONG" example is shown for routing-redirection pedagogy, but the call shape itself is also wrong post-14.6.0. Agents reading this skill mid-task may copy the shape into their actual tool calls (the OMP runtime will reject them, but the agent thinks `path` is the field name, not `paths`). The example is doubly misleading.

**Recommendation.** Update line 40 to:

```
// WRONG — blocked, returns error
search(pattern: "TODO", paths: ["src/"])
```

That keeps the routing pedagogy intact while teaching the correct field shape. No test impact.

---

## Compaction-recall hook (Monitor)

**OMP change (14.6.3).**

> Changed compaction context assembly to include backend-provided recall context when available.

**Source.** `src/context-mode/hooks.ts:759-788` registers a `session_compact` hook (which the adapter at `src/platform/omp.ts:93-95` maps to OMP's `session.compacting` pre-compaction event). The hook returns:

```ts
return {
  context: snapshot.split("\n"),
  preserveData: { resumeSnapshot: snapshot, eventCounts: ... },
};
```

**Contract.** `SessionCompactingResult.context` is documented at `omp_source/packages/coding-agent/src/extensibility/hooks/types.ts:633-634` as **"Additional context lines to include in summary"**. The wording is *additional*, not *replace*, so the new backend-recall context and our snapshot should co-exist. No regression expected.

**Recommendation.** **MONITOR only.** No action required today. If future OMP releases change the merge semantics (e.g. backend-recall and extension `context` start fighting for the same buffer), revisit. P3 / E0.

---

## Confirmed non-impacts

The following changelog entries were verified to **not** affect supipowers:

| Changelog | Verification |
|---|---|
| 14.6.3 — `PI_HASHLINE_SEP` → `PI_HL_SEP`, default sep `\\` → `>` | No reference in `src/`, `tests/`, `skills/`, `bin/`, `package.json`. supipowers does not read this env var or generate hashline payloads. |
| 14.6.3 — Inline hashline edit syntax (`< ANCHOR${sep}TEXT` / `+ ANCHOR${sep}TEXT`) | Edit-tool syntax for spawned agents. supipowers does not generate atom/hashline payloads. |
| 14.6.3 — `memory.backend` setting + Hindsight memory subsystem | No references in source. supipowers maintains its own context-mode `MemoryStore` (`src/context-mode/memory-store.ts`) and clears it via `src/commands/clear.ts:377` — both unrelated to OMP's hindsight surface. |
| 14.6.3 — `retain` / `recall` / `reflect` tools | Spawned-agent capabilities. Extension does not register or consume them. |
| 14.6.3 — `hindsight.scoping`, `hindsight.dynamicBankId` removal, `HINDSIGHT_*` env vars | No references in source. The only `agentName` usages in supipowers (`src/types.ts:713,745,832`, `src/ultraplan/contracts.ts:303,324,364`, `src/ultraplan/execution/session-runner.ts:194,213`) are our internal review/ultraplan agent identity, namespaced separately. |
| 14.6.3 — `/memory view`, `/memory clear`, `/memory enqueue` route through backend | Extension does not invoke these slash commands. |
| 14.6.3 — `github` tool `search_code` / `search_commits` / `search_repos` | Extension shells out to `gh` CLI deterministically (`src/release/channels/github.ts:10,23`, `src/fix-pr/fetch-comments.ts:111,127`, `src/commands/{doctor,fix-pr,release}.ts`). These ops are LLM-callable; the extension's gh shell-outs are not search-typed (auth check, release create, PR detection, comment fetch). No migration appropriate. |
| 14.6.3 — `search_repos` runs as global search | Same as above. |
| 14.6.3 — Multi-path `search`/`find`/`ast_*` skip missing base paths and report skipped paths | Extension does not author prompts that advise agents on multi-path resilience. No skill mentions this. Behavior change is transparent. |
| 14.6.3 — Hindsight queue/batching, queue flush on agent_end/clear/enqueue, `Memory queued.` return | Hindsight only; not used. |
| 14.6.3 — Multi-path search/find/ast_edit/ast_grep return matches when some paths missing | Internal tool resilience. No prompts in supipowers tell agents about path-not-found semantics. |
| 14.6.2 — `statusLine.sessionAccent`, WSL OSC 11 disable, SSH ControlMaster `%C` | User-facing config and environment fixes. No extension impact. |
| 14.6.1 — GitHub call header titles, terminal-width truncation, fallback rendering | UI for OMP github tool calls. Extension uses `gh` CLI directly, not the OMP tool. |
| 14.6.0 — Autoresearch storage rework + protocol split (`init_experiment` schema, `run_experiment`, `log_experiment`, branch scoping, dirty-worktree refusal, two-phase Phase 1/Phase 2) | No `autoresearch` references in `src/`, `tests/`, `skills/` (verified). |
| 14.6.0 — `update_notes` tool | Autoresearch-only. |
| 14.6.0 — Removed `PI_STRICT_EDIT_MODE` | Not set or read by extension. |
| 14.6.0 — Atom edit auto-rebase warning dedup, hash placeholder fix, run-collapse fix, brace-indent foot-gun, AUTO-FIX message reformat | Edit-tool fixes. supipowers does not author atom payloads. |
| 14.6.0 — Multi-target search/ast_grep/ast_edit run-each-target-separately, pagination/match-count fix | Internal tool fix. Skills/prompts unaffected. |
| 14.6.0 — `log_experiment keep` dirty-path filter fix | Autoresearch-only. |
| 14.5.14 — Defer Turndown/fflate/browser-agent loading; flush `lastChangelogVersion` immediately | Performance / OMP-internal bug fixes. No surface used by extension. |
| 14.5.13 — Removed `python` tool, `python.toolMode` setting, `./ipy/*` exports | **Verified clean.** Sub-agent confirmed zero references to OMP `python` tool name, allowlist entries, or `python.toolMode`. References in `src/context-mode/sandbox/runners.ts` and `src/context-mode/tools.ts` are our own `ctx_execute` sandbox runner that takes `language: "python"` — independent feature. |
| 14.5.13 — `eval` wire format change to single `input` string with fenced blocks | Extension does not call `eval` directly. The OMP `eval` tool is LLM-callable; extensions never construct its payload. |
| 14.5.13 — `eval.py` / `eval.js` settings | User-level config. |
| 14.5.13 — `exec` maps to `eval` when any eval backend enabled | Extension never emits `exec` calls. Routing layer (`src/context-mode/routing.ts`) intercepts `bash`, `search`, `find`, `fetch`, `web_fetch` only. |
| 14.5.13 — Eval Python preflight skip; eval JS fallback when Python unavailable | Internal OMP startup fix. |
| 14.5.13 — Stable MCP tool ordering; skip redundant system-prompt rebuilds | Internal performance / cache fix. |
| 14.5.13 — AGENTS.md discovery respects `.gitignore` | OMP-internal. supipowers' own AGENTS.md scan in `src/context/startup-optimizer.ts:185` and `src/git/conventions.ts:33` is independent and already filesystem-direct. |
| 14.5.13 — Parallelized plugin root preloading and `createAgentSession` bootstrap | Internal performance. |
| 14.5.13 — Eval startup messaging | User-facing. |

---

## Opportunities

### O1 — LSP `capabilities` action (P2 · S · ADOPT)

**Trigger.** OMP 14.5.13 added a `capabilities` action that returns standard + experimental + executeCommand lists for one server (via `file`) or all servers (via `file: "*"`).

**Current state.** `src/lsp/detector.ts:26-28` only checks whether the literal string `"lsp"` is in `getActiveTools()`. That tells us a server is registered — not whether it actually supports the methods we drive (`textDocument/diagnostic`, `textDocument/references`).

**Where it would land.**
- `src/lsp/detector.ts:isLspAvailable` could be extended (or paired with a new `isLspMethodAvailable(method, file?)` helper) that probes capabilities once per session.
- `src/lsp/bridge.ts:24-87` (`buildLspDiagnosticsPrompt` / `collectLspDiagnostics`) and `src/lsp/bridge.ts:92-98` (`buildLspReferencesPrompt`) can guard their prompts on the actual method support, so a quality gate against a server that doesn't implement diagnostics fails fast instead of silently returning empty.

**Effort.** Small. One new helper, one capability probe per quality-gate run, two callsite gates. No new dependencies.

**Recommendation.** **ADOPT.** Quality gates currently silent-fail when an LSP server is registered but lacks the requested method (e.g. some Python LSPs lack workspace diagnostic). This is the most concrete-payoff item in the entire 14.5.13 → 14.6.3 window for supipowers.

---

### O2 — LSP `rename_file` with `apply: false` preview (P3 · S · CONSIDER)

**Trigger.** OMP 14.5.13 added `rename_file` with the `workspace/willRenameFiles` + `workspace/didRenameFiles` flow, plus `apply: false` preview mode.

**Current state.** `src/lsp/bridge.ts:92-98` (`buildLspReferencesPrompt`) only instructs the spawned agent to `lsp action: "references"` before editing. There is no extension-side flow that moves files and follows up with import-path rewrites — the closest is the `/supi:fix-pr` flow which only edits in place.

**Recommendation.** **CONSIDER** only when supipowers grows a refactor/move command. For 1.5.3 there is no callsite to upgrade; logging this for a future "rename module / move file" feature.

---

### O3 — LSP `request` action (raw method invocation) (P3 · XS · SKIP)

**Trigger.** OMP 14.5.13 added a generic `request` action with auto-built `textDocument`/`position` parameters.

**Current state.** All LSP usage in supipowers is prompt-driven: `src/lsp/bridge.ts` embeds natural-language instructions for spawned agents. No extension-side code calls `lsp` directly.

**Recommendation.** **SKIP.** Adding raw protocol method names into prompt strings increases brittleness without solving any current problem. Revisit only if a structured call from extension code becomes necessary.

---

### O4 — Eval JS backend (P2 · XS · SKIP)

**Trigger.** OMP 14.5.13 added a JavaScript backend to `eval` with an in-process VM and helper bridge (`read`, `write`, `glob`).

**Current state.** `src/context-mode/sandbox/runners.ts` runs JS/TS via `bun run` subprocess, with stdout-only isolation. That subprocess sandboxing is the **feature**, not a limitation — context-mode's design is to keep raw data in the sandbox and surface only printed summaries.

**Recommendation.** **SKIP.** The two execution surfaces have different contracts. Eval's in-process VM is a quick-compute primitive; ctx_execute is a high-output sandbox. They do not compete.

---

### O5 — `exec` → `eval` remap (P1 · XS · SKIP)

**Trigger.** OMP 14.5.13: "Changed execution/tool discovery flow so `exec` maps to `eval` when any `eval` backend is enabled."

**Current state.** `src/context-mode/routing.ts:75-128` intercepts `bash`, `search`, `find`, `fetch`, `web_fetch` only. supipowers never emits an `exec` call.

**Recommendation.** **SKIP.** The remap is transparent to our routing layer.

---

### O6 — `github` tool search ops (P3 · XS · SKIP)

**Trigger.** OMP 14.6.3 added `search_code`, `search_commits`, `search_repos` to the `github` tool.

**Current state.** Extension shells out to `gh` CLI from deterministic command code (six callsites in `src/release/channels/github.ts`, `src/fix-pr/`, `src/commands/{doctor,fix-pr,release}.ts`). None are search-typed.

**Recommendation.** **SKIP.** OMP's `github` tool is LLM-callable — it lives in the agent's tool catalog. Migrating extension shell-outs to it would invert control flow with no payoff. The only legitimate adoption path is mentioning these new ops in a future skill that instructs the agent to discover repos / search code on GitHub. No such skill exists in 1.5.3.

---

### O7 — Multi-path tool resilience (P3 · — · SKIP)

**Trigger.** OMP 14.6.3: multi-path `search`/`find`/`ast_edit`/`ast_grep` now skip missing base paths and report which paths were skipped. OMP 14.6.0 fixed multi-target path handling to run each resolved target separately.

**Current state.** No skill, agent prompt, or system-prompt template in supipowers advises agents on `paths` array semantics. `skills/`, `src/review/default-agents/`, `src/ultraplan/default-agents/` have zero references to ast_grep / ast_edit. There is no doc to extend.

**Recommendation.** **SKIP.** The runtime improvement is transparent; existing multi-path calls silently become more resilient.

---

## Summary table

| Type | ID | Severity / Priority | Effort | File / Pointer | Action |
|---|---|---|---|---|---|
| Breaking | B1 | Critical | S | `src/ui-design/session.ts:768-793` + 6 tests at `tests/ui-design/session.test.ts:303-373` | Read `input.paths: string[]` (with `input.path` legacy fallback for one release). |
| Breaking | B2 | High | S | `src/context-mode/source-hash.ts:126-138` + 3 tests at `tests/context-mode/source-hash.test.ts:158-204` + new `metrics-store` v3 migration | Switch search/find branches to `paths: string[]`; null obsolete hashes on schema bump. |
| Breaking | B3 | Medium | XS | `skills/context-mode/SKILL.md:40` | Replace `path: "src/"` with `paths: ["src/"]`. |
| Monitor | M1 | P3 | — | `src/context-mode/hooks.ts:759-788` (compaction hook) | Watch OMP for change in `SessionCompactingResult.context` merge semantics. No action today. |
| Opportunity | O1 | P2 | S | `src/lsp/detector.ts:26-28`, `src/lsp/bridge.ts:24-98` | Adopt `lsp action: "capabilities"` to gate diagnostics/references prompts on actual server support. |
| Opportunity | O2 | P3 | S | none | Consider for a future refactor/move command; no current callsite. |
| Opportunity | O3 | P3 | XS | none | Skip — no extension-side LSP callsites. |
| Opportunity | O4 | P2 | XS | `src/context-mode/sandbox/runners.ts` | Skip — different sandboxing contract. |
| Opportunity | O5 | P1 | XS | `src/context-mode/routing.ts` | Skip — remap is transparent. |
| Opportunity | O6 | P3 | XS | none | Skip — extension uses `gh` CLI deterministically. |
| Opportunity | O7 | P3 | — | none | Skip — no doc to extend. |

**Migration order.** B1 → B2 → B3 in lockstep with their tests; ship as a single PR titled `chore(omp-14.6.0): migrate search/find/ast_edit path → paths`. Then independently consider O1 in a separate PR.
