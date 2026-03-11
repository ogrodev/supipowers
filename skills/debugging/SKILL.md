---
name: debugging
description: Systematic debugging approach — investigate before fixing
---

# Debugging Skill

## Process

1. **Reproduce**: Can you reliably trigger the bug?
2. **Isolate**: What's the smallest input that triggers it?
3. **Investigate**: Read the relevant code. Trace the execution path.
4. **Hypothesize**: Form a theory about the root cause.
5. **Verify**: Add logging or a test that confirms the theory.
6. **Fix**: Make the minimal change that fixes the root cause.
7. **Validate**: Run the reproducer and existing tests.

## Rules

- Never guess-and-fix. Investigate first.
- After 3 failed fix attempts, step back and question your assumptions.
- Fix the root cause, not the symptom.
- Add a test that would have caught this bug.
