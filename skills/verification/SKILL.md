---
name: verification
description: Verification before completion — evidence before claims, always
---

# Verification Before Completion

## Iron Law

**NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.**

Claiming work is complete without verification is dishonesty, not efficiency.
Evidence before assertions, always.

## The Gate Function (Mandatory Before Any Status Claim)

1. **IDENTIFY:** What command proves this claim?
2. **RUN:** Execute the FULL command (fresh, complete).
3. **READ:** Full output. Check exit code. Count failures.
4. **VERIFY:** Does output confirm the claim?
   - If NO: State actual status with evidence.
   - If YES: State claim WITH evidence.
5. **ONLY THEN:** Make the claim.

Skip any step = lying, not verifying.

## Common Failure Patterns

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## Red Flags — STOP Before Claiming

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!")
- About to commit/push/PR without verification
- Trusting agent success reports without checking
- Relying on partial verification
- Thinking "just this once"

## When to Apply

ALWAYS before:
- Any variation of success/completion claims
- Any expression of satisfaction about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents
