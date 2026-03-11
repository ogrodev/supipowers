---
name: qa-strategy
description: QA test planning for comprehensive coverage
---

# QA Strategy Skill

## Test Pyramid

1. **Unit tests**: Fast, isolated, cover individual functions
2. **Integration tests**: Test component interactions
3. **E2E tests**: Test user-facing flows end-to-end

## When to Write What

- New function → unit test
- New API endpoint → integration test
- New user flow → E2E test
- Bug fix → regression test at the appropriate level

## Coverage Priorities

Focus testing effort on:
1. Business logic (highest value)
2. Error handling paths
3. Edge cases in input validation
4. Integration points (API boundaries, DB queries)

Don't test:
- Framework boilerplate
- Simple getters/setters
- Third-party library behavior
