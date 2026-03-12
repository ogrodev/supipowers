---
name: debugging
description: Systematic debugging — find root cause before attempting fixes, 4-phase investigation process
---

# Systematic Debugging

## Iron Law

**NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Symptom fixes are failure. If you haven't completed Phase 1, you cannot propose fixes.

## Phase 1: Root Cause Investigation

Complete this phase before proposing any fix.

1. **Read error messages carefully.** Don't skip; they often contain solutions.
2. **Reproduce consistently.** Exact steps, every time.
3. **Check recent changes.** `git diff`, new dependencies, config changes.
4. **Gather evidence** in multi-component systems: diagnostic instrumentation at each boundary.
5. **Trace data flow** backward through call stack to find original trigger.

## Phase 2: Pattern Analysis

1. Find working examples in codebase.
2. Compare against references completely (not skimming).
3. Identify differences between working and broken.
4. Understand dependencies and assumptions.

## Phase 3: Hypothesis and Testing

1. Form a single, specific hypothesis (not vague).
2. Test minimally: smallest possible change, one variable at a time.
3. Verify before continuing. If wrong → form NEW hypothesis, not more fixes.
4. Admit uncertainty. Don't pretend to know.

## Phase 4: Implementation

1. Create failing test case first.
2. Implement single fix addressing root cause only.
3. Verify: test passes, no other tests broken.
4. **If fix doesn't work:**
   - < 3 attempts: Return to Phase 1 with new information
   - ≥ 3 attempts: **STOP** and question the architecture. Discuss with human partner.

## Red Flags — STOP and Follow the Process

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "One more fix attempt" (when already tried 2+)
- Each fix reveals new problem in different place

## When to Use (Especially)

- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- Already tried multiple fixes
- Don't fully understand the issue
