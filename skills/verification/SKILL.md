---
name: verification
description: Verification before completion — evidence before claims, always
---

# Verification Before Completion

Evidence before assertions. No completion claim without fresh verification output.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Scope** | Every status/completion claim before it leaves the agent |
| **Input** | A completion claim about to be made (tests pass, build succeeds, bug fixed, etc.) |
| **Output** | The claim restated with evidence (command + output), OR a corrected status with evidence |
| **Core rule** | Run the proving command → read its full output → cite evidence in the claim |

## The Gate Function

Before making any status claim, execute these steps in order:

1. **IDENTIFY** — What single command proves this claim?
2. **RUN** — Execute it fresh: no `--filter`, no subset, no cached result.
3. **READ** — Check exit code. Scan output for failure/error indicators. Count failures.
4. **VERIFY** — Does the output confirm the claim?
   - **YES →** State claim with evidence (command run + key output).
   - **NO →** State actual status with evidence. Do not soften.
5. **CLAIM** — Only now may you assert completion.

### Before / After

**Bad — claiming without evidence:**
```
I've fixed the failing test. The build should be green now. Moving on to the next task.
```

**Good — Gate Function applied:**
```
Ran `bun test src/auth.test.ts` — 14/14 passing, exit 0.
Ran `bun run build` — compiled successfully, exit 0.
Auth fix verified: original symptom (401 on refresh) no longer reproduces.
```

**Bad — partial verification presented as full:**
```
Ran the linter — 0 errors. Build succeeds.
```
(Linter passing does not prove the build succeeds. Two different commands.)

**Good — each claim has its own proof:**
```
Ran `eslint src/` — 0 errors, 0 warnings.
Ran `bun run build` — exit 0, bundle output at dist/.
Both linter and build verified independently.
```

## Common Failure Patterns

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output showing 0 failures | Previous run, "should pass" |
| Build succeeds | Build command with exit 0 | Linter passing, "logs look good" |
| Bug fixed | Original symptom reproduced and now passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle: test fails without fix, passes with it | Test passes once |
| Agent completed task | VCS diff shows expected changes | Agent self-reports "success" |
| Requirements met | Each requirement checked against output/behavior | "Tests passing" (tests may not cover all requirements) |

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Run the exact proving command fresh before claiming | Rely on a previous run or memory |
| Cite command + output in the claim | Use hedging words: "should", "probably", "seems to" |
| Verify each distinct claim with its own command | Substitute one verification for another (linter ≠ build) |
| Check agent work via VCS diff, not agent self-report | Trust agent/tool success messages without checking |
| State actual status when verification fails | Express satisfaction ("Done!", "Perfect!") before verifying |

## Final Checklist

Before any completion claim, confirm:

- [ ] Proving command identified and executed fresh
- [ ] Exit code checked
- [ ] Output scanned for errors/failures — count is zero
- [ ] Evidence (command + key output) included in the claim
- [ ] Each distinct claim verified independently
- [ ] If delegated to agent: VCS diff reviewed, not just agent report
