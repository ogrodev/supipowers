---
name: tdd
description: Test-driven development — write the test first, watch it fail, write minimal code to pass
---

# Test-Driven Development

## Iron Law

**NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**

Write code before the test? Delete it. Start over. No exceptions.

## Red-Green-Refactor

### RED — Write Failing Test

- One behavior per test. "and" in the name? Split it.
- Clear name that describes behavior.
- Real code, not mocks (unless unavoidable).

**Watch it fail. MANDATORY.**
- Confirm: fails (not errors), failure message expected, fails because feature missing.
- Test passes? You're testing existing behavior. Fix the test.

### GREEN — Minimal Code

Write the simplest code that makes the test pass.

- Don't add features, refactor other code, or "improve" beyond the test.

**Watch it pass. MANDATORY.**
- Confirm: test passes, other tests still pass, output pristine.
- Test fails? Fix code, not test.

### REFACTOR — Clean Up (After Green Only)

- Remove duplication, improve names, extract helpers.
- Keep tests green. Don't add behavior.

## Verification Checklist

Before marking work complete:

- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason (feature missing, not typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass with pristine output
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

## Red Flags — STOP and Start Over

- Code before test
- Test after implementation
- Test passes immediately
- Can't explain why test failed
- Tests added "later"
- Rationalizing "just this once"

All of these mean: delete code, start over with TDD.

## Testing Anti-Patterns

- Don't test mock behavior instead of real behavior
- Don't add test-only methods to production classes
- Don't mock without understanding dependencies
- Mocks are tools to isolate, not things to test

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test | Write wished-for API. Write assertion first. Ask. |
| Test too complicated | Design too complicated. Simplify interface. |
| Must mock everything | Code too coupled. Use dependency injection. |
| Test setup huge | Extract helpers. Still complex? Simplify design. |

## Bug Fix Flow

Bug found? Write a failing test reproducing it. Follow the TDD cycle.
The test proves the fix and prevents regression. Never fix bugs without a test.
