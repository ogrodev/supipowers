---
name: receiving-code-review
description: Receiving code review feedback — verify before implementing, technical rigor not performative agreement
---

# Receiving Code Review

Code review requires technical evaluation, not emotional performance. Verify before implementing. Technical correctness over social comfort.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Input** | Review comments (inline or summary), PR diff, full codebase access |
| **Output** | Per-comment response (acknowledgment, pushback, or question) + code changes with tests |
| **Core loop** | Read → Understand → Verify → Evaluate → Respond → Implement |
| **Key rule** | Every suggestion is a hypothesis — verify it against the codebase before acting |

## The Response Pattern

1. **Read** the complete feedback without reacting.
2. **Understand** — restate the requirement, or ask for clarification.
3. **Verify** — does the issue actually exist? Does the cited pattern match what's in the code?
4. **Evaluate** — does the suggestion match established patterns? Break existing callers? Warrant its scope?
5. **Respond** — technical acknowledgment or reasoned pushback.
6. **Implement** — one item at a time, test each change.

## Acceptable vs Forbidden Responses

| Forbidden (performative agreement) | Acceptable (technical acknowledgment) |
|------------------------------------|---------------------------------------|
| "You're absolutely right!" | "Fixed. [description of what changed]" |
| "Great point!" / "Excellent catch!" | "Good catch — [issue]. Fixed in [location]." |
| Any empty praise before acting | "I disagree because [technical reason]. Here's why: ..." |

If ANY item is unclear, stop and ask for clarification before implementing. Review items may have dependencies — implementing one may invalidate another. Clarify all unclear items before starting work.

## Source-Specific Handling

| Source | Trust level | Approach |
|--------|------------|----------|
| Human partner | High trust | Implement after understanding. Still verify complex or cross-cutting changes against codebase. |
| External reviewer | Verify first | Check technically. Look for breaking changes. Confirm the reviewer has full context. |

## When to Push Back

Push back when feedback would:
- Introduce bugs or break existing behavior
- Add unnecessary complexity (YAGNI — grep codebase for actual usage before implementing suggested features)
- Contradict established codebase patterns
- Solve a problem that doesn't exist

## Implementation Order

1. Clarify all unclear items first
2. Blocking issues (must fix)
3. Simple fixes (quick wins)
4. Complex fixes (may need discussion)
5. Test each change before moving to the next

## Example: Full Review Cycle

**Review comment:** _"This should use a builder pattern instead of direct construction for `SessionConfig`."_

**Wrong response:**
> "Great suggestion! Refactoring to builder pattern now."

Implements builder pattern without checking whether it fits. Ships unnecessary abstraction.

**Correct response:**

1. **Verify**: grep codebase for `SessionConfig` construction sites — find 2 call sites, both pass 3 fields.
2. **Evaluate**: builder pattern adds complexity for 2 simple call sites. No optional fields, no conditional construction. YAGNI.
3. **Respond**:
   > "`SessionConfig` has 2 call sites, both passing the same 3 required fields. A builder adds indirection without benefit here. If construction grows more complex, I'll revisit. Keeping direct construction — thoughts?"
4. **Outcome**: pushback accepted. No unnecessary abstraction shipped.

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Verify every suggestion against actual codebase state | Agree performatively then implement blindly |
| Restate requirements before implementing | Skip unclear items and guess intent |
| Push back with technical evidence | Push back with defensiveness or emotion |
| Implement and test one item at a time | Batch-implement all feedback untested |
| Treat partner feedback as high-trust, not infallible | Treat any source as unconditionally trusted |

## Final Checklist

- [ ] Every comment has a response: acknowledgment, question, or reasoned pushback
- [ ] No performative agreement — every response contains technical content
- [ ] Unclear items clarified before any implementation started
- [ ] Each change tested before moving to the next
- [ ] Pushbacks cite codebase evidence, not opinion
