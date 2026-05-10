# OMP Changelog Audit — 14.7.2 → 14.9.3

| Field | Value |
|---|---|
| OMP version range claimed | 14.7.2 → 14.9.3 |
| OMP versions with changelog entries | 14.7.4, 14.7.5, 14.7.6, 14.7.8, 14.8.0, 14.9.0, 14.9.2, 14.9.3 |
| supipowers version | 2.0.1 |
| Audit date | 2026-05-10 |
| Prior audit baseline | 14.7.2 (`.omp/omp-audit-config.json`) |
| Changelog source | `https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/CHANGELOG.md` |

## Executive summary

**Zero hard runtime breakages**, but the 14.9.3 system-prompt restructure (commit `f849407c` "added prompt markers to system prompt assembly") quietly degrades two diagnostic commands. The audit produced one priority-elevated cluster (**C2/C3**) and one cleanup (**C1**).

| Area | Finding |
|---|---|
| **C1 (P3, XS)** | 14.7.4 removed the `notebook` tool. `src/ui-design/session.ts:787-788` carries a `case "notebook":` arm in the ui-design write-scope guard that is now unreachable — drop it. |
| **C2 (P2, S)** | 14.9.3 wraps project context in `<\|START_PROJECT\|>...<\|END_PROJECT\|>` (and adds `<\|START_ENV\|>` / `<\|START_CONTRACT\|>` envelopes around environment and contract blocks). `parseSystemPrompt` (`src/context/analyzer.ts:222,233`) still matches only legacy `<project>` / `<instructions>` XML and now silently drops the project context label. Verified empirically: a 14.9.3-style prompt produces `[AGENTS.md, Memory, MCP instructions, Base system prompt]` instead of `[..., Project context]`. `/supi:context` and `/supi:optimize-context` show a less informative breakdown. |
| **C3 (P2, S)** | `parseIndividualSkills` (`src/context/analyzer.ts:59-103`) is broken end-to-end against current OMP prompts: it scans for `## skill-name` headings under `# Skills`, but OMP renders skills as a bulleted list (`- skill-name: description`). Worse, on the same input it accidentally captures any later `## …` heading (e.g. `## MCP Server Instructions`) and reports it as a "skill" — verified empirically. This pre-dates 14.9.3 (the bullet format has been the OMP shape since at least 14.7.x), but the new wrappers make the breakage easier to notice. Fix as part of the same change as C2. |

Three transparent reliability wins land automatically for every `createAgentSession` call supipowers makes (35 callsites across nine subsystems):

1. **14.7.6 per-step system-prompt preparation timeout fallback** — a slow `buildAgentsMdSearch` / `buildWorkspaceTree` / `loadProjectContextFiles` step no longer collapses preparation to minimal defaults; only the failing step falls back.
2. **14.7.8 startup hang fix (#975)** — `createAgentSession`'s blocking `Promise.all` previously bypassed the 5s preparation deadline. Now bounded; git worktrees additionally short-circuit through `git ls-files --cached --others --exclude-standard`.
3. **14.9.2 single `listWorkspace` walk** — startup workspace discovery now performs one native walk for both the rendered tree and AGENTS.md discovery, replacing the prior layered `git ls-files` orchestration plus a secondary AGENTS.md glob. AGENTS.md files that are explicitly gitignored are now included while still excluding files under ignored directories.

Verified non-impacting breaking changes:

- **14.9.0** moved hashline APIs to `@oh-my-pi/pi-coding-agent/hashline` and removed `edit/modes/hashline` / `edit/line-hash` source subpaths — supipowers imports none of these (`grep -rn 'edit/modes/hashline\|edit/line-hash\|hashline\|line-hash' src/ tests/` → no matches).
- **14.9.0** removed hashline auto-rebase — agent-tool behavior only.
- **14.9.3** removed the `===== ` eval-cell input format — supipowers does not synthesize eval inputs (`grep -rn '\*\*\* Begin\|===== ' src/` → only unrelated HTML/CSS section comments inside `src/visual/scripts/frame-template.html`).
- **14.9.3** removed `sectionSeparator` re-export from `@oh-my-pi/pi-coding-agent/config/prompt-templates` — supipowers does not import this (`grep -rn 'sectionSeparator\|prompt-templates' src/ tests/ package.json` → no matches).
- **14.9.3** removed `head` and `tail` parameters from the `bash` tool schema (plus the `normalizeBashCommand` / `applyHeadTail` module) — supipowers does not synthesize bash inputs with those parameters.

| ID | Severity | File:Line | What breaks |
|---|---|---|---|
| B1 | None (dead code) | `src/ui-design/session.ts:787-788` | The `case "notebook":` arm is unreachable but harmless. |
| B2 | Diagnostics degraded | `src/context/analyzer.ts:222,233` | "Project context" section no longer detected; project content lumps into "Base system prompt". |
| B3 | Diagnostics broken (pre-existing) | `src/context/analyzer.ts:59-103` | `parseIndividualSkills` returns 0 real skills and 1+ spurious matches against current OMP prompts. |
| B4..B8 | None | — | No code reference. |

| ID | Priority | Effort | Benefit |
|---|---|---|---|
| C1 | P3 | XS | Delete two lines of dead code (`case "notebook":`) in `getUiDesignWritePaths`. |
| C2 | P2 | S | Restore "Project context" section labelling for `/supi:context` and `/supi:optimize-context` against OMP ≥14.9.3. |
| C3 | P2 | S | Fix `parseIndividualSkills` to read OMP's bullet-list `# Skills` block (and stop grabbing later h2 sections). Bundle with C2. |
| O1 | P3 | XS | Document OMP ≥14.7.8 in README/CHANGELOG to immunize users from the large-repo startup hang and the 14.9.2 workspace-discovery improvement. |

---

## Breaking Changes

### B1 — 14.7.4: dedicated `notebook` tool removed; `.ipynb` now flows through `read`/`edit` (dead-code branch in ui-design guard)

**Changelog (14.7.4 Breaking Changes).**

> Removed the dedicated `notebook` tool; `.ipynb` reads and edits now go through `read` and `edit`.

**Status.** No runtime breakage. supipowers does not invoke the `notebook` tool, register one, or feed it through the platform tool registration API. The only `notebook` reference is `src/ui-design/session.ts:787-788`, a `case "notebook":` arm inside `getUiDesignWritePaths(toolName, input)`:

```ts
// src/ui-design/session.ts:768-792
function getUiDesignWritePaths(toolName: string, input: Record<string, unknown>): string[] | undefined {
  switch (toolName) {
    case "write": ...
    case "ast_edit": { ... }
    case "edit": { ... }            // ← handles .ipynb via input.edits[].path under new routing
    case "notebook":                 // ← unreachable: OMP no longer dispatches `notebook` tool calls
      return [typeof input.notebook_path === "string" ? input.notebook_path : ""];
    default: return undefined;
  }
}
```

The `case "edit":` arm immediately above reads `input.edits[].path` (every edit operation carries its target path). Since `.ipynb` edits are now serialized through `edit`, the ui-design write-scope guard correctly captures the notebook file path through the existing `edit` arm. No behavioral gap. See **C1** for the recommended removal.

### B2 — 14.9.3: new `<|START_PROJECT|>...<|END_PROJECT|>` system-prompt wrapper (diagnostics degraded)

**Changelog (14.9.3 Added/Changed).**

> Added a new `[project]` prompt block wrapper around workstation and workspace context and ensured it is emitted as a separate system prompt segment.
> Changed system prompt rendering to use block markers such as `[env]`, `[contract]`, `[role]`, `[coop]`, and `[closure]` for more explicit structural instructions.

**Status.** The `[project]` etc. names are the **internal template-engine block IDs**. The actual marker syntax emitted in the rendered system prompt text is the pipe-delimited `<|START_PROJECT|>...<|END_PROJECT|>` family (confirmed by reading the upstream template at `packages/coding-agent/src/prompts/system/project-prompt.md` on `main`, and by reading the system prompt currently rendered into this agent session, which contains `<|START_ENV|>`, `<|START_CONTRACT|>`, `<|START_PROJECT|>`).

Commit `f849407c` ("added prompt markers to system prompt assembly", 2026-05-10) introduced these wrappers for the first time:

```diff
# packages/coding-agent/src/prompts/system/project-prompt.md
+ <|START_PROJECT|>
  <workstation>
  ...
+ <|END_PROJECT|>
```

**supipowers parser is now stale.** `src/context/analyzer.ts` still pattern-matches the legacy XML shapes:

```ts
// src/context/analyzer.ts:221-241
// Project section FIRST (so nested <file> tags inside <project> are consumed)
const projMatch = text.match(/<project>([\s\S]*?)<\/project>/);
...
// Instructions section
const instrMatch = text.match(/<instructions>([\s\S]*?)<\/instructions>/);
```

Neither pattern fires against an OMP 14.9.3 prompt: the wrappers are `<|START_PROJECT|>`/`<|END_PROJECT|>` and there is no top-level `<instructions>` wrapper in the new template.

**Empirical verification.** I composed a representative OMP 14.9.3 prompt shape and ran it through `parseSystemPrompt` / `parseIndividualSkills` directly:

```
LABELS: [ "AGENTS.md", "Memory", "MCP instructions", "Base system prompt" ]
SECTION_COUNT: 4
PROJECT_CONTEXT_DETECTED: false
BASE_INCLUDES_PROJECT_MARKER: true   ← project content swept into "Base system prompt"
BASE_INCLUDES_ENV_MARKER: true       ← env block also unlabelled
```

What still works:

- `<file path="...">` matches against the inner file tags inside `<context>` (OMP still renders these per-file) → AGENTS.md and other file sections are still detected.
- `# Memory Guidance`, `# context-mode — MANDATORY routing rules`, `## MCP Server Instructions` heading patterns still match (these are not affected by the project-prompt restructure).

What breaks:

- "Project context" section is no longer detected; workstation, dir-context, workspace-tree, and append-prompt content all fall into "Base system prompt" undifferentiated.
- Extension instructions wrapper detection (`<instructions>`) was also lost — this pattern hasn't fired in modern OMP for some time; it is dead code regardless.

**Impact.** `/supi:context` (commands/context.ts:70) and `/supi:optimize-context` (commands/optimize-context.ts:78) consume `parseSystemPrompt`. Their TUI breakdowns are now less informative — users see a single "Base system prompt" bucket where they used to see "Project context" plus "Base".

`/supi:context` does not crash; the parser returns sections, and the breakdown renders without errors. This is a soft regression.

**Recommendation.** See **C2**.

### B3 — Pre-existing: `parseIndividualSkills` misreads OMP's bullet-list `# Skills` block

**Status.** This is not a 14.9.3-specific change, but the 14.9.3 audit surfaced it. OMP renders skills as a bullet list under a `# Skills` h1 heading:

```
# Skills
- accessibility-compliance: Implement WCAG 2.2 …
- adapt: Adapt designs to work across different screen sizes …
- animate: …
```

(Verified by reading `packages/coding-agent/src/prompts/system/system-prompt.md` on `main`, where the template is:

```
{{#if skills.length}}
# Skills
{{#each skills}}
- {{name}}: {{description}}
{{/each}}
{{/if}}
```

and by reading the actual system prompt rendered to this agent session.)

**supipowers parser assumption.** `src/context/analyzer.ts:59-103` looks for `## skill-name` h2 headings under `# Skills`:

```ts
// src/context/analyzer.ts:66-68
const skillsSectionMatch = systemPrompt.match(
  /^# Skills\n[\s\S]*?\n(?=##\s)/m,
);
if (!skillsSectionMatch) return [];
```

When the body uses bullets, this regex matches the region from `# Skills` up to the **next h2 heading anywhere in the prompt**, then attempts to extract sub-`## ` headings. Two consequences:

1. Real skills (rendered as bullets) are never extracted — `headings` array is empty, so the function returns `[]` for the genuine skill list.
2. The function captures whatever h2 happens to appear next. In practice, this is `## MCP Server Instructions` (which is appended to the prompt). The empirical test returned `SKILLS: [ "MCP Server Instructions" ]` — a single, incorrect entry.

**Impact.** `/supi:optimize-context` (commands/optimize-context.ts:79) feeds `parseIndividualSkills` output into the optimization plan and the per-skill token accounting in `buildContextReport`. With the broken parse, the per-skill breakdown is silently empty or wrong; the optimizer's skill-trimming recommendations are meaningless on real OMP prompts.

**Tests.** `tests/context/analyzer.test.ts:147-153` pins synthetic XML-tag inputs (`<skill name="a">content a</skill>`), so the tests pass while the production behavior is broken against current OMP output. This is the canonical "happy-path-only test" anti-pattern.

**Recommendation.** See **C3**.

### B4 — 14.7.4: `notebook.enabled` config option removed (no impact)

`grep -rn 'notebook\.enabled\|notebook_enabled' src/ tests/` → no matches.

### B5 — 14.7.4: `.ipynb` reads/edits route through notebook serialization helpers (no impact)

`grep -rn '\.ipynb' src/ tests/ skills/` → no matches. supipowers does not synthesize agent `read`/`edit` payloads for `.ipynb` files.

### B6 — 14.9.0: hashline APIs moved to `@oh-my-pi/pi-coding-agent/hashline` (no impact)

`grep -rn 'edit/modes/hashline\|edit/line-hash\|hashline\|line-hash' src/ tests/ package.json` → no matches. supipowers does not import OMP's hashline module from any subpath.

### B7 — 14.9.3: `===== ... =====` eval-cell input format removed (no impact)

`grep -rn '\*\*\* Begin\|===== ' src/ tests/` only matches unrelated HTML/CSS section comments in `src/visual/scripts/frame-template.html` (e.g. `/* ===== THEME VARIABLES ===== */`) and a test fixture string `"======= 1 failed, 2 passed ======="`. supipowers does not generate eval inputs.

### B8 — 14.9.3: `sectionSeparator` re-export removed from `config/prompt-templates` (no impact)

`grep -rn 'sectionSeparator\|prompt-templates' src/ tests/ package.json` → no matches. supipowers does not import `sectionSeparator` from any path.

### B9 — 14.9.3: `head` / `tail` parameters removed from `bash` tool schema (no impact)

`grep -rn 'head:\|tail:\|normalizeBashCommand\|applyHeadTail' src/ tests/` returns only unrelated occurrences of the word `detail` (substring match). supipowers does not synthesize bash tool inputs with `head`/`tail` parameters.

---

## Opportunities

### C1 — Drop the unreachable `case "notebook":` in the ui-design write-scope guard (P3, XS)

**Why.** Captured under B1. The 14.7.4 OMP release removed the `notebook` tool. The branch at `src/ui-design/session.ts:787-788` cannot be reached on any supported OMP version.

**Concrete change.**

```diff
--- a/src/ui-design/session.ts
+++ b/src/ui-design/session.ts
@@
     case "edit": {
       ...
     }
-    case "notebook":
-      return [typeof input.notebook_path === "string" ? input.notebook_path : ""];
     default:
       return undefined;
   }
```

**Tests.** None to update — `grep -rn 'notebook' tests/ui-design/` returns no matches. After deletion, run `bun test tests/ui-design/`.

**Risk.** Effectively zero.

**Effort.** XS — two-line removal, one file, no tests to delete.

### C2 — Teach `parseSystemPrompt` about `<|START_PROJECT|>...<|END_PROJECT|>` (P2, S)

**Why.** Captured under B2. Project context is no longer labelled in `/supi:context` and `/supi:optimize-context` breakdowns under OMP ≥14.9.3.

**Concrete change.** In `src/context/analyzer.ts` (`extractXmlSections`), add a wrapper-aware matcher that recognizes both the legacy `<project>` shape and the new pipe-delimited form. Suggested implementation:

```ts
// src/context/analyzer.ts (replace lines 221-230)
const projectWrapperPatterns: RegExp[] = [
  /<\|START_PROJECT\|>([\s\S]*?)<\|END_PROJECT\|>/,
  /<project>([\s\S]*?)<\/project>/, // keep for legacy / synthetic inputs
];
for (const pattern of projectWrapperPatterns) {
  const projMatch = text.match(pattern);
  if (projMatch && !consumed.has(projMatch.index!)) {
    sections.push({
      label: "Project context",
      bytes: byteLength(projMatch[0]),
      content: projMatch[0],
    });
    markConsumed(consumed, projMatch.index!, projMatch.index! + projMatch[0].length);
    break;
  }
}
```

Optionally extend the same pattern to capture the new `<|START_ENV|>...<|END_ENV|>` and `<|START_CONTRACT|>...<|END_CONTRACT|>` envelopes as their own labelled sections ("Environment" and "Contract"). This is purely additive — it gives users a more granular breakdown without breaking any existing matcher.

Drop the legacy `<instructions>` matcher (line 233 of analyzer.ts) since OMP no longer emits that wrapper at any version supipowers supports; keep it only if there's evidence some other consumer still emits it.

**Tests.** Update `tests/context/analyzer.test.ts`:

1. Lines 82-86 ("extracts project section") — add a parallel test for the new wrapper:
   ```ts
   test("extracts project section (new pipe-wrapper form)", () => {
     const prompt = "<|START_PROJECT|>\n<workstation>\nOS: darwin\n</workstation>\n<|END_PROJECT|>";
     const sections = parseSystemPrompt(prompt);
     expect(sections.find((s) => s.label === "Project context")).toBeDefined();
   });
   ```
2. Lines 155-160 ("does not double-count <file> nested inside <project>") — add the parallel new-wrapper assertion.

**Verification.** After the change, the synthetic 14.9.3 prompt from this audit should produce `[Project context, AGENTS.md, Memory, MCP instructions, Base system prompt]` (5 labels) instead of the current 4. AGENTS.md detection inside the project wrapper continues to work because `<file path="...">` matching runs after the project match consumes the outer wrapper but does not consume the inner content (per the existing `consumed` set logic).

**Effort.** Small. ~30-40 lines including tests.

**Risk.** Low — purely additive. The legacy regex remains in place for older OMP versions and synthetic test inputs.

### C3 — Fix `parseIndividualSkills` to read OMP's bullet-list `# Skills` block (P2, S)

**Why.** Captured under B3. The function currently returns 0 real skills and 1+ spurious matches against real OMP system prompts.

**Concrete change.** Rewrite `parseIndividualSkills` (`src/context/analyzer.ts:59-103`) to match the OMP bullet-list shape, with the legacy `## name` heading form preserved as a fallback for synthetic inputs and any extensions that still render that way:

```ts
export function parseIndividualSkills(systemPrompt: string): ParsedSkill[] {
  if (!systemPrompt) return [];

  // Extract the # Skills block (bounded by the next h1 heading or end of text).
  const skillsBlock = systemPrompt.match(/^# Skills\n([\s\S]*?)(?=^# [^#]|\Z)/m);
  if (!skillsBlock) return [];

  const body = skillsBlock[1];
  const skills: ParsedSkill[] = [];

  // Modern OMP shape: "- skill-name: description" bullet list.
  const bulletRegex = /^- ([a-zA-Z0-9_-]+):\s*(.*?)(?=^- [a-zA-Z0-9_-]+:|\Z)/gms;
  let match: RegExpExecArray | null;
  while ((match = bulletRegex.exec(body)) !== null) {
    const content = match[0];
    skills.push({
      name: match[1],
      bytes: byteLength(content),
      tokens: estimateTokens(content),
      content,
    });
  }
  if (skills.length > 0) return skills;

  // Legacy fallback: "## skill-name" h2 sub-headings (synthetic test inputs, older OMP).
  const headingRegex = /^## (.+)$/gm;
  const headings: { name: string; index: number }[] = [];
  while ((match = headingRegex.exec(body)) !== null) {
    headings.push({ name: match[1].trim(), index: match.index });
  }
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : body.length;
    const content = body.slice(start, end).trimEnd();
    skills.push({
      name: headings[i].name,
      bytes: byteLength(content),
      tokens: estimateTokens(content),
      content,
    });
  }
  return skills;
}
```

The critical change is the addition of `(?=^# [^#]|\Z)` to bound the Skills block at the next top-level heading or end-of-text. The previous regex (`/^# Skills\n[\s\S]*?\n(?=##\s)/m`) had no upper bound and would slurp content well past the Skills block.

**Tests.** Update `tests/context/analyzer.test.ts` — currently `parseIndividualSkills` is not directly tested (only `parseSystemPrompt`'s `<skills>` XML handling is). Add a new describe block:

```ts
describe("parseIndividualSkills", () => {
  test("parses bullet-list skills from OMP system prompt", () => {
    const prompt = "# Skills\n- planning: Plan your work\n- code-review: Review code\n\n## MCP Server Instructions\nUnrelated";
    const skills = parseIndividualSkills(prompt);
    expect(skills.map(s => s.name)).toEqual(["planning", "code-review"]);
  });

  test("does not capture later h2 sections as skills", () => {
    const prompt = "# Skills\n- a: x\n\n## MCP Server Instructions\nstuff";
    const skills = parseIndividualSkills(prompt);
    expect(skills.find(s => s.name.includes("MCP"))).toBeUndefined();
  });

  test("falls back to ## headings when no bullets present (legacy / synthetic)", () => {
    const prompt = "# Skills\n## planning\nPlan content";
    const skills = parseIndividualSkills(prompt);
    expect(skills.map(s => s.name)).toEqual(["planning"]);
  });
});
```

**Verification.** Run `bun test tests/context/analyzer.test.ts`.

**Effort.** Small. ~50 lines including new test block.

**Risk.** Low — the bullet matcher is well-bounded and the heading fallback preserves legacy behavior for any synthetic inputs.

### O1 — Document OMP ≥14.7.8 (and the 14.9.2 workspace-discovery improvement) in CHANGELOG / README (P3, XS)

**Why.** Three changelog entries collectively make `createAgentSession` significantly more robust in large monorepos:

- 14.7.6 — per-step system-prompt preparation timeout fallback;
- 14.7.8 — startup hang fix (#975) with bounded scans + git-aware listing;
- 14.9.2 — single `listWorkspace` walk for both rendered tree and AGENTS.md discovery, plus correctly including gitignored top-level AGENTS.md files.

supipowers issues `createAgentSession` from 35 sites across nine subsystems (`grep -rn 'createAgentSession(' src/`):

| Subsystem | Representative callsite |
|---|---|
| ai (final-message / structured-output) | `src/ai/final-message.ts:93` |
| context-mode hooks | `src/context-mode/hooks.ts:265` |
| harness pipeline | `src/harness/command.ts:375`, `src/harness/stage-runner.ts` |
| ultraplan authoring stages | `src/ultraplan/authoring/stages/{intake,scout,discover,research,synthesize,review}.ts` |
| ultraplan execution | `src/ultraplan/execution/session-runner.ts:157` |
| review pipeline | `src/review/{runner,multi-agent-runner,fixer,validator}.ts` |
| fix-pr | `src/fix-pr/assessment.ts` |
| docs drift | `src/docs/drift.ts` |
| quality gates | `src/quality/{runner,ai-setup,gates/ai-review}.ts` |
| ui-design system prompt | `src/ui-design/system-prompt.ts` |

Every one of these inherits the improvements transparently.

**Recommendation.** No code change. Add a line to `CHANGELOG.md` ("Compatibility") in the next supipowers release:

> Recommend OMP ≥14.7.8 to avoid startup hang on large monorepos (oh-my-pi#975); OMP ≥14.9.2 additionally consolidates workspace discovery into a single walk and correctly includes top-level gitignored AGENTS.md files.

`peerDependencies` in `package.json:70-75` currently pins `@oh-my-pi/pi-coding-agent: "*"` (verified). Promoting a hard floor would be expressed there. Defer that decision until the next OMP cycle.

**Effort.** XS — two lines of prose.

---

## Other changelog entries reviewed and dismissed

| Entry | Status | Why no impact |
|---|---|---|
| 14.7.5 — `/loop` count/duration limits | No impact | OMP slash command; supipowers does not register, gate, or react to `/loop`. The `loop: {delaySeconds, maxIterations}` in `src/fix-pr/config.ts:15` is the fix-pr command's own retry policy. |
| 14.7.5 — `/loop` status message + malformed-arg errors | No impact | TUI behavior inside OMP. |
| 14.7.5 — Inherited `MallocStackLogging` env vars no longer leak to Bun subprocesses on macOS | Transparent benefit | `grep -rn 'MallocStackLogging\|malloc.*stack' src/ tests/ bin/` → no matches. supipowers' `platform.exec` callers (release, docs/drift, fix-pr, git/commit, etc.) get cleaner stdout for free on macOS. |
| 14.7.6 — "Hide Thinking Blocks" provider propagation | No impact | TUI/provider knob orthogonal to supipowers' typed `thinkingLevel` option. `grep -rn 'hideThinking\|thinking\.display\|reasoning\.summary' src/ tests/` → no matches. |
| 14.7.6 — System-prompt preparation keeps successful context data on partial failure | Transparent benefit | Applied to every supipowers `createAgentSession`. Captured in O1. |
| 14.7.6 — Per-step system-prompt preparation timeout | Transparent benefit | Captured in O1. |
| 14.7.6 — Parents forward `AGENTS.md` search and workspace tree to subagents through `createAgentSession` | No impact | OMP-internal forwarding for `task`-tool subagent spawns. supipowers' `createAgentSession` callsites are all parent/headless sessions — no parent to inherit from. The bounded-scan changes (14.7.8/14.9.2) are what protect supipowers' callers. |
| 14.7.8 — `createAgentSession` startup hang fix #975 | Transparent benefit | Captured in O1. |
| 14.8.0 — Hashline stale-anchor recovery via session snapshot | No impact | Agent-tool behavior; supipowers does not produce hashline edits programmatically. |
| 14.8.0 — Legacy pi-extension bare-specifier import fix | No impact | Applies to `omp-legacy-pi-file:` namespace plugins. supipowers is an OMP extension declared via `package.json` `omp.extensions`, not a legacy pi plugin. |
| 14.8.0 — Hashline success output warning on stale-anchor recovery | No impact | TUI output for the agent's edit tool. |
| 14.9.0 — Compaction fallback when current model has no credentials (#986) | Transparent benefit | Applies to OMP's compaction system. supipowers does not invoke compaction directly. |
| 14.9.0 — JS eval top-level static-import rewriting + `import ... with` attribute fixes | No impact | Agent eval tool. |
| 14.9.0 — `modelRoles` fully-qualified provider/id error on missing pair (#980) | Transparent benefit | supipowers default models in `src/commands/fix-pr.ts:330` and elsewhere use unqualified IDs (e.g. `"claude-sonnet-4-6"`), so the new error path does not fire. If a user ever sets a provider-prefixed model in their `model.json`, they now get a clear error instead of silent provider drift. |
| 14.9.0 — Anthropic `metadata.user_id` stability/correctness fixes | No impact | Provider-side; supipowers does not synthesize Anthropic metadata. |
| 14.9.0 — Plan-mode review resubmits append refined plan to scrollback | No impact | TUI/plan-mode. |
| 14.9.0 — Multi-file legacy Pi extensions failing to load (#983) | No impact | Legacy pi plugins. |
| 14.9.0 — Sub-agent dispatch falls back to parent's model when subagent model has no auth (#985) | No impact | Applies to OMP's `task` tool spawn dispatch. supipowers resolves models itself in `resolveModelForAction` and passes them explicitly to `createAgentSession`; the OMP fallback does not apply. Worth awareness: if a future supipowers feature delegates to OMP `task` tool, this fallback would kick in. |
| 14.9.0 — Debug-panel raw SSE stream viewer | No impact | TUI feature. |
| 14.9.0 — Legacy Pi plugin Windows drive-letter fix (#990) | No impact | Legacy pi plugins. |
| 14.9.0 — `get_login_providers` / `login` RPC commands | No impact | RPC surface for headless clients; supipowers is not an RPC client. |
| 14.9.2 — `agentsMdFiles` added to `WorkspaceTree` | No impact | supipowers does not import `WorkspaceTree` (`grep -rn 'WorkspaceTree\|buildWorkspaceTree\|agentsMdFiles' src/ tests/` → no matches). |
| 14.9.2 — Single `listWorkspace` walk for tree + AGENTS.md discovery | Transparent benefit | Captured in O1. |
| 14.9.2 — Gitignored top-level AGENTS.md files now included in directory-context | Transparent benefit | Applies during system-prompt preparation for every supipowers `createAgentSession`. |
| 14.9.2 — `task` tool renderer no longer warns while streaming (#985) | No impact | TUI rendering. |
| 14.9.2 — MCP HTTP streamable transport leak fix | Transparent benefit | supipowers configures MCP servers via `src/mcp/` (transport types include `"http"` / `"sse"`) but does not implement the transport itself. OMP's transport bug fix benefits users whose `.mcp.json` declares an HTTP-streamable MCP server. |
| 14.9.3 — Eval `*** Abort` recovery marker; `*** Begin Patch`/`*** End Patch` hashline envelopes; HTML rendering for eval cells, `search`, `recipe`, `irc`; `Available Tools` collapsible | No impact | All agent-tool / TUI features. |
| 14.9.3 — Dedicated `[now]` prompt block (current date/cwd/end-of-turn guidance) | Transparent benefit | Appended by OMP after extension-supplied blocks; supipowers does not need to emit a now-block of its own. |
| 14.9.3 — Bash guidance forbids `sed`/`awk` line-range reads, stderr redirects, `\| head\|tail` pagination | Transparent benefit | Matches supipowers' existing `AGENTS.md` and skill instructions; nothing to update. |
| 14.9.3 — Subagent prompt assembly with `[now]` block placement and shared task context in `[context]` block | No impact | OMP-internal `task` subagent assembly. |
| 14.9.3 — GitHub (`gh`) tool cards include op/PR/branch/title details | Transparent benefit | TUI rendering for the GitHub tool that `/supi:release` and `/supi:fix-pr` could call. |
| 14.9.3 — Tool-call output hides internal `_i` intent | Transparent benefit | TUI rendering. |
| 14.9.3 — `ast_edit`/`find`/`search` rendering shows resolved path values + flags | Transparent benefit | TUI rendering. |
| 14.9.3 — macOS power assertion settings (`power.preventIdleSleep`, etc.) | No impact | User-side OMP config; supipowers does not set or read these. |
| 14.9.3 — Power-assertion behavior changes (lifecycle, state recovery) | No impact | OMP runtime concern. |
| 14.9.3 — IRC background exchange poll loop leak fix on session disposal | No impact | OMP runtime concern; supipowers does not use the `irc` tool. |

---

## Verification commands

```bash
# B1 — dead-code branch
grep -rn 'case "notebook"\|notebook_path' src/ tests/

# B2 — current parser does not detect <|START_PROJECT|>
grep -rn '<project>\|<\\|START_PROJECT\\|>' src/ tests/

# B3 — parseIndividualSkills against bullet-list block
grep -rn 'parseIndividualSkills\|^# Skills' src/

# B6 — no hashline subpath imports
grep -rn 'edit/modes/hashline\|edit/line-hash\|hashline\|line-hash' src/ tests/ package.json

# B7 — no eval-cell input synthesis
grep -rn '\*\*\* Begin\|===== ' src/ tests/

# B8 — no sectionSeparator import
grep -rn 'sectionSeparator\|prompt-templates' src/ tests/ package.json

# B9 — no bash head/tail params
grep -rn 'head:\|tail:\|normalizeBashCommand\|applyHeadTail' src/ tests/

# B5 — no .ipynb references
grep -rn '\.ipynb' src/ tests/ skills/

# O1 — every createAgentSession callsite that benefits transparently
grep -rn 'createAgentSession(' src/
```

To reproduce the B2/B3 empirical findings, run a parser sanity check against a representative OMP 14.9.3 prompt (the script is small enough to inline; the audit ran exactly this script and observed `[AGENTS.md, Memory, MCP instructions, Base system prompt]` for `parseSystemPrompt` and `[ "MCP Server Instructions" ]` for `parseIndividualSkills`).

---

## Summary table

| Category | Count |
|---|---|
| Breaking changes affecting supipowers at runtime | **0** |
| Breaking changes with diagnostic-degradation follow-up | 2 (B2 → C2, B3 → C3) |
| Breaking changes with dead-code follow-up | 1 (B1 → C1) |
| Breaking changes verified non-impacting | 6 (B4 = 14.7.4 `notebook.enabled` removal placeholder; B5 = 14.7.4 ipynb routing; B6 = 14.9.0 hashline; B7 = 14.9.3 eval format; B8 = 14.9.3 `sectionSeparator`; B9 = 14.9.3 bash `head`/`tail`) |
| Cleanup opportunities (P2) | 2 (C2, C3) |
| Cleanup opportunities (P3) | 1 (C1) |
| Documentation opportunities (P3) | 1 (O1) |
| Changelog entries reviewed and dismissed | 30+ |
| Changelog version gaps in audit input | None — 14.7.4, 14.7.5, 14.7.6, 14.7.8, 14.8.0, 14.9.0, 14.9.2, 14.9.3 all covered; 14.7.3 / 14.7.7 / 14.8.1 / 14.9.1 had no entries in the upstream changelog |

**Required follow-ups before next OMP upgrade:** none.
**Recommended follow-ups during normal maintenance:** **C2 + C3** as one change (restore `/supi:context` and `/supi:optimize-context` diagnostic fidelity against OMP ≥14.9.3), **C1** (delete the unreachable `notebook` branch when next touching `src/ui-design/session.ts`), **O1** (document OMP ≥14.7.8 / ≥14.9.2 in CHANGELOG / README).
