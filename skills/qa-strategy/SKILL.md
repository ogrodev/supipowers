---
name: qa-strategy
description: E2E QA strategy — flow-based product testing with disciplined triage, regression detection, and autonomous execution
---

# E2E QA Strategy

Test the product the way a user uses it. Every test simulates a real user flow — navigating, clicking, filling forms, waiting for responses.

**This is NOT unit or integration testing.** This pipeline tests complete user journeys through the running application.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Scope** | End-to-end Playwright tests against a running app |
| **Input** | Running app URL, optional prior test results for regression comparison |
| **Output** | Test files (one flow per file), triage verdicts for every failure, regression report |
| **Core rule** | Every failure gets a verdict before the next test runs |
| **Priority** | Critical/High flows first; stop adding flows when context reaches ~80% capacity |
| **Independence** | Each test is self-contained — no shared state, no execution order dependency |

## Flow Prioritization

| Priority | What Breaks | Examples |
|----------|-------------|----------|
| **Critical** | Revenue or access | Login, checkout, payment, signup |
| **High** | Core product value | Create/edit main entities, dashboard, search |
| **Medium** | Secondary features | Settings, profile, notifications |
| **Low** | Polish | Theme toggle, tooltips, animations |

A session that thoroughly tests 5 critical flows beats one that superficially touches 20.

## Flow Discovery

Before writing tests, understand what the product does:

1. **Scan routes and pages** — every URL is a potential flow entry point
2. **Identify forms** — login, signup, search, create, edit — high-value interaction points
3. **Map navigation** — how does a user get from A to B? What's the happy path?
4. **Find auth boundaries** — public vs protected; test both sides
5. **Check CRUD operations** — create, read, update, delete for core entities

If prior test results exist, compare to detect new, removed, and changed flows.

## Playwright Discipline

### Locators — Resilient Only

```typescript
// GOOD — survives refactoring
page.getByRole('button', { name: 'Submit' })
page.getByLabel('Email')
page.getByText('Welcome back')
page.getByTestId('user-avatar')

// BAD — breaks on any styling change
page.locator('.btn-primary')
page.locator('#submit-btn')
page.locator('div > form > button:nth-child(2)')
```

### Waiting — Explicit Conditions Only

```typescript
// GOOD — waits for something specific
await page.waitForResponse(resp => resp.url().includes('/api/users'));
await expect(page.getByText('Success')).toBeVisible();
await expect(page.getByText('Loading...')).not.toBeVisible();

// BAD — arbitrary delay, flaky by design
await page.waitForTimeout(3000);

// BAD — unreliable for SPAs (sockets stay open; resolves before dynamic content loads)
await page.waitForLoadState('networkidle');
```

### One Flow Per File

```typescript
test.describe('Checkout flow', () => {
  test('adds item to cart', async ({ page }) => { /* ... */ });
  test('fills shipping info', async ({ page }) => { /* ... */ });
  test('completes payment', async ({ page }) => { /* ... */ });
  test('shows confirmation', async ({ page }) => { /* ... */ });
});
```

## Failure Triage

When a test fails, classify it **immediately** — before running the next test.

| Verdict | Meaning | Action |
|---------|---------|--------|
| **Bug** | App behavior is wrong | Record as regression. Do not change the test assertion — the test is correct, the app is broken. |
| **Stale assertion** | App changed intentionally | Update the test to match new behavior. |
| **Flaky** | Non-deterministic failure (evidence of randomness required) | Fix the locator or wait condition. Re-run once. |
| **Test error** | Test code itself is wrong | Fix the test code and re-run. |

### Triage Process

1. **Read the error.** What element wasn't found? What URL didn't match? What assertion failed?
2. **Check if the app changed.** Did a route move? Did a button get renamed? New loading state?
3. **Distinguish bug from change.** Intentional change → update test. Unintentional breakage → regression.
4. **Don't retry blindly.** If you can't explain why a test failed, investigate before retrying.

### Example: Classifying a Real Failure

```
Error: expect(getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  → Timeout 5000ms exceeded.
  → Call log: waiting for getByRole('heading', { name: 'Dashboard' })
```

| Step | Finding |
|------|---------|
| Read error | Heading "Dashboard" not found after login |
| Check app | Route `/dashboard` now redirects to `/home`; heading changed to "Home" |
| Verdict | **Stale assertion** — intentional redesign |
| Action | Update test: navigate to `/home`, assert "Home" heading |

## Regression Analysis

A regression is a flow that **was passing** and now **fails**.

Regressions are the pipeline's highest-priority output.

For each regression, record:

| Field | Value |
|-------|-------|
| **Flow** | Which user flow broke |
| **Previous status** | Last known passing state |
| **Current error** | Error message and failing assertion |
| **Classification** | Real bug or intentional change |

## Session Checklist

Before finishing, verify every item:

| Check | Pass | Fail |
|-------|------|------|
| Every failure has a verdict | ✓ | Failures left unclassified |
| Critical flows tested before lower-priority | ✓ | Random or low-priority-first ordering |
| Regressions recorded with all fields | ✓ | Vague "some tests failed" |
| Tests are independent and resilient | ✓ | Tests depend on execution order or shared state |
| Context spent on high-value flows | ✓ | Low-priority flows tested while critical flows skipped |
| Error states tested (API errors, bad input) | ✓ | Only happy paths covered |

## MUST / MUST NOT

| MUST | MUST NOT |
|------|----------|
| Triage every failure before proceeding | Accumulate failures to analyze later |
| Use resilient locators (role, label, text, testid) | Use CSS selectors or DOM position |
| Wait for explicit conditions (element, response) | Use `waitForTimeout` or `networkidle` |
| Test what the user sees | Test internal state (stores, localStorage, cookies) |
| Provide evidence before classifying a failure as "flaky" | Classify regressions as flaky without proof of non-determinism |
| Test error states and edge cases | Only test happy paths |
