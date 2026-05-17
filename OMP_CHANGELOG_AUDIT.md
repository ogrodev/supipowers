# OMP Changelog Audit — 15.1.0 → 15.1.3

| Field | Value |
| --- | --- |
| OMP range analyzed | 15.1.0 → 15.1.3 (incl. 15.1.2) |
| supipowers version | 2.2.0 |
| Audit date | 2026-05-17 |
| Previous audit | 15.0.1 → 15.1.0 (2026-05-15) |

> Evidence convention: every claim cites `file:line` ranges. Read with `read <path>:N-M` to verify in-place.

> Scope: every breaking item in 15.1.2 and 15.1.3 was probed against `src/`, `tests/`, shipped `skills/`, shipped `.omp/rules/`, and shipped `.omp/skills/`. Auto-indexed batch search returned 0 in-repo hits for `pi://`, `PiProtocolHandler`, `StringEnum`, `*** Cell`, `*** End`, `*** Abort`, `pty: true`, and the SSH/YieldTool surfaces. All "no-impact" verdicts below cite the actual grep commands and their negative results.

---

## 1. Breaking changes that affect supipowers

### 1.1 [NONE] `pi://` → `omp://` URL scheme + `OmpProtocolHandler` rename — no in-repo references

**Changelog source (15.1.3):**
> Renamed the embedded-documentation internal URL scheme from `pi://` to `omp://`. `OmpProtocolHandler` replaces `PiProtocolHandler`; update any external references accordingly.

**Evidence collected.** Searched the full repo (excluding `node_modules`, `.git`, `dist`, `omp_source/` upstream tree, and runtime data under `.omp/supipowers/`) for:

- `grep -rn 'pi://' src tests skills global-config docs` → **0 matches**
- `grep -rn 'PiProtocolHandler' src tests` → **0 matches**
- `grep -rln 'pi://' .omp/rules .omp/skills` → **0 matches**

Stray hits all lived inside the upstream-vendored tree `omp_source/packages/coding-agent/` (`internal-urls/pi-protocol.ts` etc.), which we do not author or ship. The previous audit's reference to the embedded-doc scheme was hypothetical; the codebase has never consumed it.

**Verdict.** No code, prompt, skill, rule, or doc in supipowers references the old scheme. The upstream rename is transparent.

**Recommendation.** None.

---

### 1.2 [LOW – DOCS DRIFT] `StringEnum` removed from `@oh-my-pi/pi-coding-agent`

**Changelog source (15.1.3):**
> Removed the `StringEnum` re-export from `@oh-my-pi/pi-coding-agent`. Custom tools and extensions should use `z.enum([...])` directly via the injected `pi.zod`.

**Runtime impact: none.** `grep -rln 'StringEnum' src tests` → **0 matches**. Supipowers never imported `StringEnum`; all our tool `parameters:` are plain JSON-Schema literals (`src/harness/tools.ts`, `src/ultraplan/authoring/authoring-tools.ts`, `src/ultraplan/authoring-tool.ts`, `src/context-mode/tools.ts`, `src/planning/planning-ask-tool.ts`, `src/mempalace/tool.ts`), as documented in the previous audit's §3.

**Docs-side impact: shipped extension-dev reference is stale.** Two files under the tracked `.omp/skills/omp-extension-dev/references/` skill (loaded by `.omp/rules/omp-extension-dev.md:2`) instruct readers to import the now-removed symbol:

| File | Line | Snippet |
| --- | --- | --- |
| `.omp/skills/omp-extension-dev/references/custom_tools.md` | 122–124 | ``// Enums (use StringEnum from pi.pi for string enums)\nconst { StringEnum } = pi.pi;\nStringEnum(["staging", "production"], { description: "Target environment" })`` |
| `.omp/skills/omp-extension-dev/references/api_reference.md` | 270 | ``\| `pi.pi` \| Module \| `@oh-my-pi/pi-coding-agent` exports — `StringEnum`, `logger`, etc. \|`` |

`.omp/skills/omp-extension-dev/SKILL.md:28,31` links both files from its "Custom Tools" and "Configuration" rows, and the rule is the `omp-extension-dev` rulebook entry the model loads whenever a user works on an OMP extension. The model will happily reproduce the dead pattern.

`git ls-files .omp/skills/omp-extension-dev` confirms supipowers ships these files; they are not user-side state. The repo owns this drift.

**Recommendation.** Replace both snippets with the `pi.zod` form named in the changelog:

```ts
// .omp/skills/omp-extension-dev/references/custom_tools.md:122-124
// Enums (use pi.zod for string enums)
const { z } = pi.zod;
z.enum(["staging", "production"]).describe("Target environment")
```

```md
<!-- .omp/skills/omp-extension-dev/references/api_reference.md:270 -->
| `pi.zod` | Module | `zod/v4` — preferred schema builder (`z.object()`, `z.enum()`, …) |
| `pi.pi`  | Module | `@oh-my-pi/pi-coding-agent` exports — `logger`, lifecycle types, etc. |
```

No tests gate these docs; the change is content-only.

---

### 1.3 [NONE] `eval` tool replaced LARK input with structured `cells` array — no in-repo callers

**Changelog source (15.1.3):**
> Replaced the `eval` tool's LARK-grammar `input` string with a structured `cells` array. Each cell is `{ language: "py" | "js", code, title?, timeout?, reset? }`. Removed the implicit/sniffed language path, the `*** Cell` / `*** End` / `*** Abort` markers, and the per-cell `t:<duration>` unit suffixes — `timeout` is now seconds (1-600).

**Evidence collected.**

- `grep -rln -E '\*\*\* (Cell|End|Abort)' src tests skills global-config` → **0 matches**.
- `grep -rn -E 'name:\s*"eval"|registerTool.*name.*eval' src tests` → **0 matches**.
- `grep` for `"eval"` / `` `eval` `` / `eval tool` / `/eval` inside `src`, `tests`, `skills/`, `global-config/`, and `docs/`, after stripping the `evalua…` substring noise, returns only references to:
  - our own behavior-test framework `tests/evals/` (`tests/evals/{harness,fixtures}.ts`, `tests/evals/README.md`, `docs/supipowers/failure-mining.md:35-90`) — unrelated to OMP's `eval` tool;
  - `src/harness/artifacts/lint-configs.ts:2,125,130` and `src/harness/stages/implement-apply.ts:312,317,324,431,424` — these emit/consume `tooling.eval` config keys describing a *user project's* mutation-test/eval framework, not the OMP runtime `eval` tool.
- No subagent prompt instructs the model to call the OMP `eval` tool (`grep "use the eval"|"run eval"|"\beval("` → 0 hits outside the items above).

**Verdict.** Supipowers neither calls the OMP `eval` tool from TS code nor instructs subagents to use it through prompt text. The LARK→`cells` migration and the dropped `*** Cell` markers are transparent to us.

**Recommendation.** None.

---

### 1.4 [NONE] 15.1.2 fixed items audit

| Changelog item | Probe | Result |
| --- | --- | --- |
| SSH host add/remove not refreshing live `ssh` tool | `grep -rn -E '"ssh"\|/ssh add\|/ssh remove\|sshHost' src tests` → **0 matches** | We never drive the `ssh` tool. |
| `YieldTool` loose object output schemas | `grep -rn -E 'YieldTool\|outputSchema:\s*(true\|\{\|\?)' src` → 0 *runtime* hits; existing `outputSchema:` matches in `src/review/{multi-agent-runner,runner,validator}.ts` and `src/quality/gates/ai-review.ts` are **prompt-template strings** (e.g. `REVIEW_OUTPUT_SCHEMA_TEXT` from `src/ai/schema-text.ts`), not OMP `YieldTool` config | We never configure OMP's `YieldTool`; schema validation flows through our own `parseStructuredOutput` (`src/ai/structured-output.ts:124`). |
| Unconstrained `outputSchema` modes (`outputSchema: true` / absent) | Same as above | We never pass `outputSchema` to `createAgentSession`; `src/ai/final-message.ts:89-99` shows the full options surface we use. |
| Bash `pty: true` hang on Windows | `grep -rn -E 'pty:\s*true' src tests` → **0 matches** | We never request a PTY. |
| MCP/theme schema metadata → JSON Schema draft-2020-12 | `.omp/mcp.json:2` references the live raw GitHub URL; we already render our own schemas at draft-2020-12 (`src/ai/schema-text.ts:146`) | Nothing to migrate. |

---

### 1.5 [NONE] Other 15.1.3 fixed items

All other "Fixed" entries are scoped to subsystems we don't touch:

| Changelog item | Why we are unaffected |
| --- | --- |
| Streaming auth recovery (invalidate + retry on stale credentials) | We have no retry-on-401 wrapper around `createAgentSession`. The upstream improvement is a transparent reliability win for every supipowers AI gate; no code change required. |
| `auth-broker migrate` / `auth-gateway` startup / `discoverAuthStorage` fast-fail on non-200 snapshot | `grep -rn -E 'auth-broker\|auth-gateway' src tests` → 0 matches; we don't operate the broker/gateway ourselves. |
| `auth-broker migrate` skip `<authenticated>` placeholder credentials | Same — we never invoke broker migration. |
| `auth-gateway` token-init race fix, protocol-control rejection, usage cached-token fix, abort-before-dispatch fix | Same. |
| `/login` and `/logout` selector overflow → 10-item scroll window + PageUp/PageDown | OMP-internal TUI; our `src/commands/model-picker.ts:286-316` already implements its own scrolling window for the supipowers model picker. |

### 1.6 [NONE] TTSR `interruptMode` semantics change

**Changelog source (15.1.3):**
> Changed TTSR `interruptMode` semantics so a non-interrupting decision on a tool-source match now folds the rule reminder into that specific tool's `toolResult` content instead of queuing a loop-wide deferred follow-up turn. Text/thinking matches keep the previous deferred-injection behavior.

**Probe.** `src/commands/runbook.ts:30,145,345` and `src/context/runbook-extension-template.ts:7-179` reference TTSR rules by reading the `interruptMode` frontmatter field for display only — they do not implement or modify firing semantics. Our shipped rules at `.omp/rules/*.md` are 22 files (`acp.md`, `code-review.md`, …, `writing-skills.md`); a `grep -l 'interruptMode' .omp/rules/*.md` returns **0 matches**. None of them set `interruptMode`, so all of them inherit OMP's default. The behavior change only affects rules that combine `interruptMode: prose-only` (or similar non-interrupting modes) with tool-source matchers, neither of which any supipowers rule does.

**Verdict.** No behavioral drift in our shipped rules. The `runbook` command continues to print `Interrupt: ${rule.interruptMode ?? "default"}` unchanged.

**Recommendation.** None. If we ever author a TTSR rule with `interruptMode: prose-only` *and* a `condition` that matches against tool output, the reminder will now appear inside that tool's `toolResult` instead of as a separate next-turn nudge — keep that in mind during future authoring.

---

## 2. Opportunities

### 2.1 [P3, Trivial] Streaming-auth retry is a free reliability win

**Changelog (15.1.3 Fixed):**
> Fixed streaming API requests to recover from provider auth errors by invalidating stale credentials and retrying with a fresh key.

Our AI gates (`src/quality/gates/ai-review.ts`, `src/lsp/{capabilities,bridge}.ts`, `src/fix-pr/assessment.ts`, `src/docs/drift.ts`, `src/review/*`, `src/commands/release.ts`, `src/git/commit.ts`, `src/ultraplan/authoring/stages/*`) all route through `runWithOutputValidation` (`src/ai/structured-output.ts:160-225`) which retries only on *parse / schema* failures, not on transport errors. Transient 401s from rotated OAuth tokens previously surfaced as `agent-error` outcomes in `src/storage/reliability-metrics.ts` (`"retry-exhausted"` / `"agent-error"`); after 15.1.3 they should self-heal inside OMP and the rate of `agent-error` records in the reliability log should drop. Worth noting in release-notes; no code change.

### 2.2 [P3, Trivial] Provider auth-broker / auth-gateway is a deployment story for container users

**Changelog (15.1.3 Added):**
> Added `omp auth-broker` subcommand … `omp auth-gateway` subcommand …  
> Added `providers.<name>.transport: "pi-native"` to `models.yml`. … Use case: containerized omp installs (robomp slots, swarm extension) where the slot must stay credential-free and a sidecar gateway holds the real provider tokens.

Supipowers needs no code change — every credential we use is owned by OMP. The opportunity is **documentation-only**: users who run supipowers inside containers (robomp slot, swarm extension, CI runner) can now hide provider tokens behind a sidecar `omp auth-gateway` and pin `providers.<name>.transport: "pi-native"` plus `providers.<name>.apiKey: <gateway-bearer>` in `~/.omp/agent/models.yml`. Worth a paragraph in `README.md` under deployment guidance once we publish against an OMP version that includes 15.1.3.

### 2.3 [P3, Trivial] `auth.broker.url` / `auth.broker.token` config tier closes a model-resolution edge case for us

**Changelog (15.1.3 Added):**
> `ModelRegistry` now promotes `models.yml` `providers.<name>.apiKey` entries to `AuthStorage`'s new config-override tier (above OAuth, below `--api-key`). Pinning a bearer in `models.yml` was previously a no-op when the broker had an OAuth credential for the same provider …

`src/commands/model.ts:184-218` (`selectModelFromList`) calls `ctx.modelRegistry?.getAvailable?.()`, then renders a "no key" warning in `src/commands/model-picker.ts:303,306,323`. Pre-15.1.3, a user with OAuth credentials *and* a `models.yml`-pinned bearer for the same provider would see the OAuth resolution win silently and (post-redirect to a gateway) hit 401 — the picker would still show the model as "configured" even though dispatch was broken. 15.1.3 makes the `models.yml` bearer authoritative, so our picker's "configured" badge is now accurate end-to-end. No code change required.

### 2.4 [N/A] `dev.autoqaPush.*` and `getInstallId()` — not applicable

- `dev.autoqaPush.enabled` / `endpoint` / `token` and the `report_tool_issue` push pipeline target OMP's tool-quality grievance database. `grep -rn 'report_tool_issue' src tests` → 0 hits. Supipowers does not emit grievances; nothing to wire up.
- `getInstallId()` (new export from `@oh-my-pi/pi-utils`) provides a stable per-install UUID at `~/.omp/install-id`. Our project-scoped state already uses repo-identity slugs (`src/workspace/state-paths.ts:79-83`, `src/harness/project-paths.ts:81-82`, `src/ultraplan/project-paths.ts:73-81`) which deliberately key on repo, not host. Install-level identity is a different axis and we have no current consumer for it.

---

## 3. Files not touched and why

- `src/platform/omp.ts:101-133` — `createAgentSession` continues to extract `model` → `modelPattern`. No new option in 15.1.0–15.1.3 needs plumbing here.
- `src/ai/structured-output.ts` — still the single canonical retry/parse path; no new schema-validation hook in 15.1.3.
- `src/ai/final-message.ts:89-99` — verified that we do not pass an `outputSchema` to OMP's `createAgentSession`, so the 15.1.2 `YieldTool` loose/strict fix is irrelevant.
- `src/commands/model-picker.ts:286-316` — our own scroll/window logic is independent of OMP's `/login` selector fix.
- `src/commands/runbook.ts:25-345` — reads but does not enforce `interruptMode`; the 15.1.3 semantic change has nothing to update here.
- `.omp/mcp.json:2` — `$schema` pulls the live OMP MCP schema URL; the draft-2020-12 metadata update is transparent.

---

## 4. Summary table

| ID | Type | Severity / Priority | Effort | Surface |
| --- | --- | --- | --- | --- |
| 1.1 | Breaking | **None** — no in-repo references to `pi://` / `PiProtocolHandler` | — | — |
| 1.2 | Breaking (docs only) | **Low** — model will keep reproducing dead `StringEnum` snippet | S (2 markdown edits) | `.omp/skills/omp-extension-dev/references/custom_tools.md:122-124`, `.omp/skills/omp-extension-dev/references/api_reference.md:270` |
| 1.3 | Breaking | **None** — no caller invokes OMP `eval` tool | — | — |
| 1.4 | Breaking (15.1.2 cluster) | **None** — every probed feature (SSH tool, YieldTool, PTY bash, MCP/theme schema) is unused by supipowers | — | — |
| 1.5 | Breaking (15.1.3 fixed cluster) | **None** — all in `auth-broker` / `auth-gateway` / streaming retry / `/login` UI; out of our surface | — | — |
| 1.6 | Breaking | **None** — no shipped rule sets `interruptMode` | — | — |
| 2.1 | Opportunity (auto) | P3, Trivial | — | Reliability log; release-notes mention only |
| 2.2 | Opportunity (deployment) | P3, Trivial | S (README paragraph) | Docs only |
| 2.3 | Opportunity (auto) | P3, Trivial | — | `src/commands/model-picker.ts` "no key" badge accuracy |
| 2.4 | N/A | — | — | `report_tool_issue` and install-id are not in use |

---

## 5. Recommended landing order

1. **§1.2 docs fix** — single-PR, 2 file edits in `.omp/skills/omp-extension-dev/references/`. Removes the only post-15.1.3 misdirection supipowers ships. No tests to update, no behaviour change.
2. **§2.2 README paragraph** — fold into the next release that bumps the required OMP version past 15.1.3. Cite `transport: "pi-native"` + `omp auth-broker` + `omp auth-gateway` for container deployments.

Everything else is no-op for supipowers (15.1.0 → 15.1.3 is the cleanest delta we've audited so far).
