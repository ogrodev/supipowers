---
name: fix-pr
description: Critically assess PR review comments — verify, investigate ripple effects, then fix or reject with evidence
---

# PR Review Comment Assessment

## Core Principle

Review comments are suggestions to evaluate, not orders to follow.
Assess each one critically before acting. The reviewer may lack context you have.

## Assessment Framework

### For Each Comment, Answer:

1. **Is this valid?** Read the actual code being commented on. Does the concern apply?
2. **Is this important?** Bug fix vs style preference vs premature optimization.
3. **What breaks if we change this?** Trace callers, check tests, find ripple effects.
4. **Does the reviewer have full context?** They often review diffs, not the full picture.
5. **Is this YAGNI?** "You should also handle X" — but does X actually occur?

### Verdict Categories

- **ACCEPT**: Valid concern, should fix. Evidence: the code has the problem described.
- **REJECT**: Invalid, unnecessary, or would cause harm. Evidence: why this doesn't apply.
- **INVESTIGATE**: Need to check more before deciding. List what to check.

### Investigation Protocol

When INVESTIGATE:
1. Read the file(s) mentioned in full (not just the diff)
2. Search for usages of the symbol/pattern being discussed
3. Check test coverage for the area
4. Look at git blame — why is the code written this way?
5. Then decide ACCEPT or REJECT with evidence

## Ripple Effect Analysis

Before accepting any change:
1. **Who calls this?** Search for usages of the function/method/class
2. **Who depends on this behavior?** Check tests that assert current behavior
3. **What imports this?** Follow the dependency graph
4. **Is this a public API?** Changes to public interfaces affect consumers

If ripple effects are significant, note them in the plan so the fixer handles them.

## Grouping Strategy

Group comments that:
- Touch the same file
- Touch tightly coupled files (caller/callee, type/implementation)
- Relate to the same logical concern (e.g., "error handling in module X")

Keep separate:
- Comments on unrelated files/areas
- Cosmetic vs functional changes
- Independent features or concerns

## Comment Reply Guidelines

### For ACCEPT:
- "Fixed. [description of change]."
- "Fixed in [file]. Also updated [related file] to maintain consistency."

### For REJECT:
- "Investigated — [reason this doesn't apply]. The current implementation [explanation]."
- "This is intentional: [reason]. Changing it would [consequence]."

### For grouped fixes:
- "Addressed these comments together in [commit]. Changes: [bullet list]."

**Never use performative agreement.** No "Great catch!", "You're absolutely right!", etc.
Technical acknowledgment only.

## Common Reviewer Mistakes to Watch For

| Pattern | Reality |
|---------|---------|
| Suggesting abstraction for code used once | YAGNI — one usage doesn't need a helper |
| Requesting error handling for impossible states | Trust internal code; only validate at boundaries |
| Style preferences disguised as correctness | If it works and is readable, style is preference |
| Suggesting patterns from a different language | Follow THIS codebase's patterns |
| Not seeing the full file (diff-only context) | They may miss why code is structured this way |
| "This could be a security issue" without specifics | Ask for the specific attack vector |
| "Add tests for X" when X is already tested | Check before accepting |

## Decision Record

For each comment, record:
```
Comment #ID by @user on file:line
Verdict: ACCEPT | REJECT | INVESTIGATE
Reasoning: [1-2 sentences]
Ripple effects: [list or "none"]
Group: [group-id]
```

This record serves as the basis for reply content and fix planning.
