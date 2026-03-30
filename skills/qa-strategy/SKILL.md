---
name: qa-strategy
description: E2E QA strategy — flow-based product testing with disciplined triage, regression detection, and autonomous execution
---

# E2E QA Strategy

Test the product the way a user uses it. Every test simulates a real user flow — navigating, clicking, filling forms, waiting for responses. If a human wouldn't do it, don't test it here.

**This is NOT unit or integration testing.** This pipeline tests complete user journeys through the running application.

## Iron Law

**EVERY FAILURE GETS A VERDICT BEFORE THE NEXT TEST RUNS.**

Don't accumulate failures to analyze later. Triage each failure immediately: real bug, flaky test, or stale assertion? Unclassified failures are useless data.

## Flow Prioritization

| Priority | What Breaks | Examples |
|----------|-------------|----------|
| **Critical** | Revenue or access | Login, checkout, payment, signup |
| **High** | Core product value | Create/edit main entities, dashboard, search |
| **Medium** | Secondary features | Settings, profile, notifications |
| **Low** | Polish | Theme toggle, tooltips, animations |

Test critical and high flows first. Skip low flows when hitting the token budget. A session that thoroughly tests 5 critical flows beats one that superficially touches 20.

## Flow Discovery

Before writing tests, understand what the product does:

1. **Scan routes and pages** — every URL is a potential flow entry point
2. **Identify forms** — login, signup, search, create, edit — high-value interaction points
3. **Map navigation** — how does a user get from A to B? What's the happy path?
4. **Find auth boundaries** — public vs protected; test both sides
5. **Check CRUD operations** — create, read, update, delete for core entities

Compare against the previous matrix (if any) to detect new, removed, and changed flows.

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

// BAD — unreliable for SPAs
await page.waitForLoadState('networkidle');
```

`waitForTimeout` is never acceptable. `networkidle` is equally unreliable — SPAs keep sockets open, so it either hangs or resolves before dynamic content loads. Wait for the specific element or response that proves the page is ready.

### One Flow Per File

```typescript
test.describe('Checkout flow', () => {
  test('adds item to cart', async ({ page }) => { /* ... */ });
  test('fills shipping info', async ({ page }) => { /* ... */ });
  test('completes payment', async ({ page }) => { /* ... */ });
  test('shows confirmation', async ({ page }) => { /* ... */ });
});
```

Each test is independent — no shared state, no execution order dependency.

## Failure Triage

When a test fails, classify it immediately:

| Verdict | Meaning | Action |
|---------|---------|--------|
| **Bug** | App behavior is wrong | Record regression. Do not fix the test. |
| **Stale assertion** | App changed intentionally | Update the test to match new behavior. |
| **Flaky** | Non-deterministic failure | Fix the locator or wait condition. Re-run. |
| **Test error** | Test code is wrong | Fix and re-run. Does not count as a retry. |

### Triage Process

1. **Read the error.** What element wasn't found? What URL didn't match? What assertion failed?
2. **Check if the app changed.** Did a route move? Did a button get renamed? Is there a new loading state?
3. **Distinguish bug from change.** Intentional app change → update test. Unintentional breakage → regression.
4. **Don't retry blindly.** If you can't explain why a test failed, investigating beats retrying.

## Regression Analysis

A regression is a flow that **was passing** and now **fails**.

For each regression, record:
- Which flow broke
- What the previous status was
- What the current error is
- Whether it's a real bug or an intentional change

**Regressions are the highest-priority output of the pipeline.** A session that finds zero regressions in a stable app is successful. A session that misclassifies a regression as a flaky test has failed.

## Red Flags — STOP and Investigate

- Accumulating failures without triaging each one
- Retrying a test without understanding why it failed
- Testing internal state (stores, localStorage, cookies) instead of what the user sees
- Tests that depend on execution order or shared state
- Using `waitForTimeout` or `networkidle` instead of explicit conditions
- Spending the token budget on low-priority flows while critical flows remain untested
- Classifying a regression as "flaky" without evidence of non-determinism
- Ignoring error states — test what happens when the API errors, the network is slow, or input is invalid

## Quality Signals

| Good Session | Bad Session |
|-------------|-------------|
| Every failure has a verdict | Failures accumulated without triage |
| Critical flows tested first | Random flow ordering |
| Regressions clearly identified | "Some tests failed" |
| Tests are independent and resilient | Tests depend on execution order |
| Token budget spent on high-value flows | Budget wasted on low-priority flows |
