---
name: tdd
description: Test-driven development — write the test first, watch it fail, write minimal code to pass
---

# Test-Driven Development

Write the failing test first. Then make it pass. Then clean up. Every time.

## Quick Reference

| Field | Value |
|-------|-------|
| Scope | Any code change: new feature, bug fix, refactor |
| Input | Feature request, bug report, or function signature to implement |
| Output | Test file(s) + implementation, all tests green, no dead code |
| Cycle | RED → GREEN → REFACTOR (never skip a phase) |
| Core rule | You MUST NOT write production code without a failing test |
| Mocks | Mock only external I/O (network, filesystem, third-party APIs). All internal code uses real implementations. |

## The Cycle

### RED — Write a Failing Test

1. One behavior per test. If the name needs "and", split it.
2. Name describes expected behavior, not implementation.
3. Run the test. It MUST fail (not error). Confirm:
   - Failure message matches your expectation.
   - It fails because the feature is missing, not because of a typo or import error.
4. If the test passes immediately, you are testing existing behavior — rewrite the test.

```typescript
// RED: test for a function that doesn't exist yet
test("parsePort returns number for valid port string", () => {
  expect(parsePort("8080")).toBe(8080);
});

// Run → FAIL: parsePort is not defined
// Good: fails because the function is missing.
//
// BAD fail: "Cannot find module './parser'"
// That's an error, not a test failure. Fix the import first.
```

### GREEN — Minimal Code to Pass

1. Write the simplest code that makes the failing test pass.
2. You MUST NOT add features, refactor, or "improve" beyond what the test demands.
3. Run all tests. They MUST all pass with clean output.
4. If the new test fails, fix the code — not the test.

```typescript
// GREEN: minimal implementation — nothing extra
function parsePort(value: string): number {
  return Number(value);
}

// Run → PASS. Stop here. Don't add validation yet —
// no test demands it.
```

### REFACTOR — Clean Up (Green Tests Only)

1. Remove duplication, improve names, extract helpers.
2. Keep all tests green. You MUST NOT add behavior during refactor.
3. Limit refactor scope to code touched in this cycle. Time-box: if it takes more than a few minutes, defer to a separate cycle.

```typescript
// After adding a second test for invalid input and making it green,
// you notice duplication between parsePort and parseHost.
// REFACTOR: extract shared parsing logic.

// BEFORE (duplication)
function parsePort(v: string): number { return Number(v); }
function parseHost(v: string): string { return v.trim().toLowerCase(); }

// AFTER (shared helper, both tests still green)
function sanitize(v: string): string { return v.trim(); }
function parsePort(v: string): number { return Number(sanitize(v)); }
function parseHost(v: string): string { return sanitize(v).toLowerCase(); }
```

## Bug Fix Flow

```
Bug reported → Write failing test that reproduces it → GREEN → REFACTOR
```

```typescript
// Bug: parsePort("  8080  ") returns NaN instead of 8080.
// RED: write a test that exposes the bug
test("parsePort trims whitespace", () => {
  expect(parsePort("  8080  ")).toBe(8080);
});
// Run → FAIL: Expected 8080, received NaN. Good — bug reproduced.

// GREEN: fix the implementation
function parsePort(v: string): number {
  return Number(v.trim()); // ← minimal fix
}
// Run → PASS. Bug fixed. Test prevents regression.
```

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Run the test and watch it fail before writing code | Write production code before a failing test exists |
| Confirm failure is for the expected reason | Ignore why a test failed (typo ≠ missing feature) |
| Write the simplest passing implementation | Add unrequested features during GREEN |
| Keep all tests green during REFACTOR | Add new behavior during REFACTOR |
| Use real implementations for internal code | Mock internal modules to avoid setup effort |
| Write one assertion per behavior | Stuff multiple behaviors into one test |
| Test edge cases and error paths | Test only the happy path |

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test it | Write the API you wish existed. Write the assertion first. |
| Test too complicated | Interface too complicated. Simplify the design. |
| Must mock everything | Code too coupled. Introduce dependency injection. |
| Test setup is huge | Extract test helpers. Still complex? Simplify the production design. |
| Can't find test files / runner | Check `package.json` scripts, look for existing `*.test.*` or `*.spec.*` files, match the project's conventions. |

## Verification Checklist

- [ ] Every new function/method has a test
- [ ] Each test was watched failing before implementation
- [ ] Each failure was for the expected reason
- [ ] All tests pass with clean output
- [ ] Mocks limited to external I/O only
- [ ] Edge cases and error paths covered
- [ ] No dead code or unrequested features added
