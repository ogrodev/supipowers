---
name: debugging
description: Systematic debugging — find root cause before attempting fixes, 4-phase investigation process
---

# Systematic Debugging

Find the root cause before touching the code. Every fix without a verified root cause is a coin flip.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Trigger** | Bug report, failing test, unexpected behavior, error message |
| **Input** | Error output, stack trace, user report, failing test, or observed misbehavior |
| **Output** | Root-cause statement, minimal fix, regression test, verification evidence |
| **Gate rule** | You **MUST** complete Phase 1 before proposing any fix |
| **Escalation** | After 3 failed fix attempts → stop, reassess architecture with human partner |

## Phases

| Phase | Goal | Gate (exit when true) |
|-------|------|-----------------------|
| 1. Investigate | Identify root cause | Root cause stated as a falsifiable claim |
| 2. Analyze | Confirm via pattern comparison | Difference between working and broken code documented |
| 3. Hypothesize | Single testable prediction | Hypothesis written as "Changing [X] produces [Y] because [Z]" |
| 4. Fix | Minimal correct change | Failing test passes, no regressions |

---

## Phase 1: Root Cause Investigation

1. **Read the full error message and stack trace.** Extract: error type, file/line location, triggering input.
2. **Reproduce consistently.** Write exact steps. If it doesn't reproduce, you don't understand it yet.
3. **Check recent changes.** `git diff`, new dependencies, config changes — narrow the blast radius.
4. **Log at each boundary** in multi-component systems. Capture: timestamps, payloads, status codes.
5. **Trace data flow** backward through the call stack to the original trigger.

**Gate:** State the root cause as a single sentence before moving on.

### Example — Phase 1

```
BAD (skipping investigation):
  "TypeError: Cannot read property 'id' of undefined"
  → "I'll add a null check on line 42."

GOOD (investigating):
  "TypeError: Cannot read property 'id' of undefined at UserService.getProfile:42"
  → git diff shows fetchUser was changed yesterday to return { data: user } instead of user
  → Line 42 reads `user.id` but now receives the wrapper object
  → Root cause: fetchUser response shape changed; callers were not updated
```

## Phase 2: Pattern Analysis

1. Find a **working example** of the same pattern in the codebase.
2. **Diff working vs broken** line-by-line. Document each difference.
3. **List the assumptions** the broken code makes about its inputs, environment, and call order.

## Phase 3: Hypothesis and Testing

1. **Write the hypothesis** in this format: "Changing [X] will produce [Y] because [Z]."
2. **Test one variable** at a time — smallest possible change.
3. If the hypothesis is wrong, return to Phase 1 with the new evidence. Do not stack guesses.
4. If confidence is not high, state: "I'm uncertain because [reason]" before proceeding.

### Example — Hypothesis

```
BAD:
  "Something is wrong with the config."

GOOD:
  "Changing `loadConfig` to parseInt(env.TIMEOUT) will fix the 'NaN' comparison
   because env vars are strings and the timeout check uses numeric comparison."
```

## Phase 4: Implementation

1. **Write a failing test** that reproduces the bug.
2. **Implement a single fix** addressing the root cause only.
3. **Verify:** test passes, no other tests broken.
4. If fix fails:
   - < 3 attempts → return to Phase 1 with new information.
   - >= 3 attempts → **STOP.** Reassess the architecture. Discuss with human partner.

---

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Complete Phase 1 before proposing any fix | Skip to a fix from a stack trace alone |
| State root cause as a falsifiable claim | Propose a vague cause ("something in config") |
| Write a failing test before fixing | Skip the test and manually verify |
| Change one variable at a time | Stack multiple speculative changes |
| Escalate after 3 failed attempts | Say "one more fix attempt" after 2+ failures |

## Final Checklist

- [ ] Root cause identified and stated as a single sentence
- [ ] Working vs broken difference documented
- [ ] Hypothesis written as "Changing [X] produces [Y] because [Z]"
- [ ] Failing test written before fix applied
- [ ] Fix addresses root cause only — no speculative side-fixes
- [ ] All existing tests still pass
- [ ] After 3 failed attempts: stopped and escalated
