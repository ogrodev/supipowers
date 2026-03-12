---
name: qa-strategy
description: E2E product testing strategy using Playwright — flow-based, autonomous, close to human interaction
---

# E2E Product Testing Strategy

## Core Principle

Test the product the way a user uses it. Every test simulates a real user flow — navigating, clicking, filling forms, waiting for responses. If a human wouldn't do it, don't test it here.

**This is NOT for unit or integration tests.** This pipeline tests complete user journeys through the running application.

## Flow Discovery

Before writing tests, understand what the product does:

1. **Scan routes and pages** — every URL a user can visit is a potential flow entry point
2. **Identify forms** — login, signup, search, create, edit — these are high-value interaction points
3. **Map navigation** — how does a user get from page A to page B? What's the happy path?
4. **Find auth boundaries** — what's public vs protected? Test both sides
5. **Check CRUD operations** — can you create, read, update, delete the core entities?

## Flow Prioritization

| Priority | Description | Examples |
|----------|-------------|---------|
| **Critical** | Revenue or access blocking | Login, checkout, payment |
| **High** | Core product value | Create/edit main entities, dashboard |
| **Medium** | Secondary features | Settings, profile, search |
| **Low** | Nice-to-have | Theme toggle, tooltips |

Test critical and high flows first. Skip low flows if hitting the token budget.

## Playwright Best Practices

### Locators (prefer resilient selectors)

```typescript
// GOOD — role-based, resilient to styling changes
page.getByRole('button', { name: 'Submit' })
page.getByLabel('Email')
page.getByText('Welcome back')
page.getByTestId('user-avatar')

// BAD — fragile, breaks on refactoring
page.locator('.btn-primary')
page.locator('#submit-btn')
page.locator('div > form > button:nth-child(2)')
```

### Assertions

```typescript
// Wait for navigation
await expect(page).toHaveURL('/dashboard');

// Wait for element visibility
await expect(page.getByText('Success')).toBeVisible();

// Wait for element to disappear (loading states)
await expect(page.getByText('Loading...')).not.toBeVisible();
```

### Waiting

```typescript
// GOOD — wait for specific condition
await page.waitForResponse(resp => resp.url().includes('/api/users'));
await page.waitForLoadState('networkidle');

// BAD — arbitrary delays
await page.waitForTimeout(3000);
```

### Test Structure

One flow per file. Each test in the flow tests a step or variant:

```typescript
test.describe('Checkout flow', () => {
  test('adds item to cart', async ({ page }) => { ... });
  test('fills shipping info', async ({ page }) => { ... });
  test('completes payment', async ({ page }) => { ... });
  test('shows confirmation', async ({ page }) => { ... });
});
```

## What Makes a Good E2E Test

| Quality | Good | Bad |
|---------|------|-----|
| **User-centric** | Tests what a user would do | Tests implementation details |
| **Independent** | Each test can run alone | Tests depend on previous test state |
| **Resilient** | Uses role/label selectors | Uses CSS classes or DOM structure |
| **Fast-failing** | Fails clearly on the broken step | Fails on a timeout with no context |
| **Readable** | Test name describes the user action | Test name is a technical description |

## Common Pitfalls

1. **Testing internal state** — don't check Redux store, localStorage, or cookies directly. Test what the user sees.
2. **Flaky waits** — use `waitForResponse` or `waitForSelector`, never `waitForTimeout`.
3. **Shared state** — each test should set up its own state. Don't rely on test execution order.
4. **Over-testing** — one flow per critical path. Don't test every permutation of a form.
5. **Ignoring error states** — test what happens when the API returns an error, the network is slow, or the user enters invalid data.

## Regression Analysis

When a previously-passing test fails:

1. **Read the error** — what element wasn't found? What URL didn't match?
2. **Check if the app changed** — did a route move? Did a button get renamed?
3. **Distinguish bug from change** — if the app intentionally changed, the test needs updating. If not, it's a regression.
4. **Record the finding** — update the flow matrix with the new status and reasoning.
