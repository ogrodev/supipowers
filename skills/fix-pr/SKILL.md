---
name: fix-pr
description: Critically assess PR review comments — verify, investigate ripple effects, then fix or reject with evidence
---

# PR Review Comment Assessment

Critically assess each PR review comment — verify the concern, investigate ripple effects, then accept with a fix or reject with evidence.

## Quick Reference

| Aspect      | Detail |
|-------------|--------|
| **Trigger** | Invoked on a PR with review comments to address |
| **Input**   | PR number/URL, diff, review comments, full repo access |
| **Output**  | Per-comment decision record, grouped fix plan, reply text per comment |
| **Scope**   | Only comments on the current PR; do not refactor beyond what comments require |

## Assessment Framework

For each comment, answer:

1. **Valid?** Read the actual code (not just the diff). Does the concern apply?
2. **Severity?** Bug > correctness > consistency > style. Style-only comments are low priority.
3. **What breaks if changed?** Trace callers, check tests, find ripple effects.
4. **Full context?** Reviewers see diffs, not full files. They may miss structural reasons.
5. **YAGNI?** "You should also handle X" — does X actually occur in this codebase?

### Verdicts

- **ACCEPT** — Valid concern, will fix. Evidence: the code has the described problem.
- **REJECT** — Invalid, unnecessary, or harmful to change. Evidence: why it doesn't apply.
- **INVESTIGATE** — Need more information. List exactly what to check.

## Investigation & Ripple Effect

When a comment is non-obvious or touches shared code:

1. Read the full file(s) — not just the diff context
2. Search for usages of the symbol/pattern under discussion
3. Check test coverage — does a test assert the current behavior?
4. Follow the dependency graph: who calls this? who imports this? is it a public API?
5. Check git blame — why is the code written this way?
6. If ripple effects are significant, include them in the fix plan

Then decide ACCEPT or REJECT with evidence. INVESTIGATE is not a final state.

## Grouping Strategy

| Group together | Keep separate |
|---|---|
| Same file | Unrelated files/areas |
| Coupled files (caller/callee, type/impl) | Cosmetic vs functional changes |
| Same logical concern | Independent features |

Address grouped comments in a single commit with a bullet list of changes.

## Output Template

For each comment, produce:

```
Comment: #ID by @reviewer on file:line
Verdict: ACCEPT | REJECT
Reasoning: [1-2 sentences with evidence]
Ripple effects: [list or "none"]
Group: [group-id or "standalone"]
```

### Reply Format

**ACCEPT:** "Fixed. [description of change]." or "Fixed in [file]. Also updated [related file] for consistency."

**REJECT:** "Investigated — [reason this doesn't apply]. The current implementation [explanation]." or "This is intentional: [reason]. Changing it would [consequence]."

**Grouped:** "Addressed these comments together in [commit]. Changes: [bullet list]."

## Worked Example

> **Review comment** by @alice on `src/config.ts:42`:
> "This should validate the input before passing it to `loadConfig`. What if `path` is undefined?"

**Investigation:**
1. Read `src/config.ts` — `loadConfig` is only called from `cli/init.ts` which already validates all args via Zod schema.
2. `grep` for other callers — none. Single call site.
3. `path` is typed `string` (non-optional) in the function signature; TypeScript enforces this at compile time.

**Decision:**
```
Comment: #12 by @alice on src/config.ts:42
Verdict: REJECT
Reasoning: `path` is typed as required `string` and the sole caller validates via Zod before invocation. Adding a runtime check duplicates the type system and the caller's validation.
Ripple effects: none
Group: standalone
```

**Reply:** "Investigated — `path` is a required `string` param and the only caller (`cli/init.ts:18`) validates all args through a Zod schema before this point. Adding a runtime check would duplicate both the type constraint and the caller's validation."

## Common Reviewer Mistakes

| Pattern | Response |
|---------|----------|
| Abstraction for code used once | YAGNI — one usage doesn't need a helper |
| Error handling for impossible states | Only validate at system boundaries |
| Style preference framed as correctness | If it works and is readable, style is preference |
| Patterns from a different language/codebase | Follow THIS codebase's conventions |
| "Security issue" without a specific vector | Ask for the specific attack scenario |
| "Add tests for X" when X is already tested | Verify coverage before accepting |
| Diff-only context (missing full file) | They may miss structural reasons for the code |

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Read full file before deciding on a comment | Accept comments without verifying the concern |
| Provide evidence for every ACCEPT and REJECT | Use performative agreement ("Great catch!", "You're right!") |
| Check ripple effects before accepting changes | Fix cosmetic comments before functional ones |
| Search for existing patterns before introducing new ones | Assume the reviewer has full context |
| Resolve every INVESTIGATE to ACCEPT or REJECT | Leave comments unaddressed |

## Final Checklist

Before submitting:

- [ ] Every comment has a verdict (ACCEPT or REJECT) with evidence
- [ ] No INVESTIGATE verdicts remain unresolved
- [ ] Ripple effects checked for every ACCEPT
- [ ] Related comments grouped; each group addressed in one commit
- [ ] Reply text is technical — no performative agreement
- [ ] Fix plan covers all ACCEPT verdicts, including ripple effects
